import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Match, Prisma } from '../../generated/client';
import { normalizeName, teamNamesMatch } from './matching';
import { politeFetch } from './polite-fetch';
import type { GameStatsProvider, MatchContext, ProviderResult, ProviderStatLine } from './provider';

// API publique ballchasing.com (token gratuit, header Authorization brut).
// Free tier : 2 req/s, 500 listes/h — politeFetch (1 req/s par hôte) est
// bien en-deçà. Couverture : replays uploadés par la communauté (référents
// RLCS notamment), d'où le filtre pro=true et les retries côté ingestion.
const BASE_URL = 'https://ballchasing.com/api';

export interface BallchasingTeamSummary {
  name?: string;
  goals?: number;
}

export interface BallchasingReplaySummary {
  id?: string;
  date?: string;
  map_name?: string;
  blue?: BallchasingTeamSummary;
  orange?: BallchasingTeamSummary;
}

export interface BallchasingPlayer {
  name?: string;
  stats?: {
    core?: {
      goals?: number;
      assists?: number;
      saves?: number;
      shots?: number;
      score?: number;
    };
  };
}

export interface BallchasingReplayDetail {
  id?: string;
  status?: string;
  date?: string;
  map_name?: string;
  blue?: { name?: string; goals?: number; players?: BallchasingPlayer[] };
  orange?: { name?: string; goals?: number; players?: BallchasingPlayer[] };
}

/** Replays d'une série : les deux noms d'équipes doivent correspondre. */
export function findBallchasingReplays(
  replays: BallchasingReplaySummary[],
  teamAName: string,
  teamBName: string,
): BallchasingReplaySummary[] {
  return replays.filter((replay) => {
    const blue = replay.blue?.name ?? '';
    const orange = replay.orange?.name ?? '';
    return (
      (teamNamesMatch(blue, teamAName) && teamNamesMatch(orange, teamBName)) ||
      (teamNamesMatch(blue, teamBName) && teamNamesMatch(orange, teamAName))
    );
  });
}

/**
 * Agrège les replays d'une série (un replay = une manche) en stats par
 * joueur : les compteurs sont sommés, le côté bleu/orange étant résolu par
 * noms d'équipes replay par replay (les couleurs peuvent s'inverser).
 */
export function mapBallchasingReplays(
  replays: BallchasingReplayDetail[],
  teamAName: string,
  teamBName: string,
): ProviderStatLine[] {
  const byPlayer = new Map<
    string,
    { externalName: string; side: 'A' | 'B' | null; core: Record<string, number>; games: number }
  >();

  for (const replay of replays) {
    for (const teamSide of [replay.blue, replay.orange]) {
      const side = teamNamesMatch(teamSide?.name ?? '', teamAName)
        ? 'A'
        : teamNamesMatch(teamSide?.name ?? '', teamBName)
          ? 'B'
          : null;
      for (const entry of teamSide?.players ?? []) {
        if (!entry.name) continue;
        const key = normalizeName(entry.name);
        const core = entry.stats?.core ?? {};
        const acc = byPlayer.get(key) ?? {
          externalName: entry.name,
          side,
          core: { goals: 0, assists: 0, saves: 0, shots: 0, score: 0 },
          games: 0,
        };
        acc.side = acc.side ?? side;
        acc.core.goals += core.goals ?? 0;
        acc.core.assists += core.assists ?? 0;
        acc.core.saves += core.saves ?? 0;
        acc.core.shots += core.shots ?? 0;
        acc.core.score += core.score ?? 0;
        acc.games += 1;
        byPlayer.set(key, acc);
      }
    }
  }

  return Array.from(byPlayer.values()).map((acc) => ({
    externalName: acc.externalName,
    side: acc.side,
    raw: { games: acc.games, ...acc.core } as unknown as Prisma.InputJsonValue,
    normalized: {
      goals: acc.core.goals,
      assists: acc.core.assists,
      saves: acc.core.saves,
      shots: acc.core.shots,
      score: acc.core.score,
    },
  }));
}

/** Manches de la série : score par manche, côté A/B résolu par noms d'équipes. */
export function mapBallchasingGames(
  replays: BallchasingReplayDetail[],
  teamAName: string,
): Array<{ position: number; map: string | null; scoreA: number | null; scoreB: number | null }> {
  return replays.map((replay, index) => {
    const blueIsA = teamNamesMatch(replay.blue?.name ?? '', teamAName);
    return {
      position: index + 1,
      map: replay.map_name ?? null,
      scoreA: (blueIsA ? replay.blue?.goals : replay.orange?.goals) ?? null,
      scoreB: (blueIsA ? replay.orange?.goals : replay.blue?.goals) ?? null,
    };
  });
}

@Injectable()
export class BallchasingStatsProvider implements GameStatsProvider {
  readonly source = 'ballchasing';
  readonly gameId = 'rl' as const;
  private readonly logger = new Logger(BallchasingStatsProvider.name);

  constructor(private readonly config: ConfigService) {}

  async fetchStats(match: Match, context: MatchContext): Promise<ProviderResult | null> {
    const token = this.config.get<string>('BALLCHASING_API_KEY');
    if (!token) {
      this.logger.warn('BALLCHASING_API_KEY absent : pas de stats RL');
      return null;
    }
    if (!context.teamA || !context.teamB) return null;
    const reference = match.beginAt ?? match.scheduledAt;
    if (!reference) return null;

    // Fenêtre large : les replays sont datés à la manche, la série s'étale.
    const after = new Date(reference.getTime() - 2 * 3600 * 1000).toISOString();
    const before = new Date(
      (match.endAt ?? new Date(reference.getTime() + 6 * 3600 * 1000)).getTime() + 2 * 3600 * 1000,
    ).toISOString();
    const url =
      `${BASE_URL}/replays?replay-date-after=${encodeURIComponent(after)}` +
      `&replay-date-before=${encodeURIComponent(before)}` +
      `&pro=true&sort-by=replay-date&sort-dir=asc&count=200`;
    const listing = await this.get<{ list?: BallchasingReplaySummary[] }>(url, token);
    if (!listing) return null;

    const summaries = findBallchasingReplays(
      listing.list ?? [],
      context.teamA.name,
      context.teamB.name,
    );
    if (summaries.length === 0) {
      this.logger.warn(
        `Ballchasing : replays ${context.teamA.name} vs ${context.teamB.name} introuvables`,
      );
      return null;
    }

    // Uploads partiels : tant que toutes les manches jouées ne sont pas là,
    // on laisse le retry repasser plutôt que de figer des totaux incomplets.
    const expectedGames = (match.scoreA ?? 0) + (match.scoreB ?? 0);
    if (expectedGames > 0 && summaries.length < expectedGames) {
      this.logger.warn(
        `Ballchasing : ${summaries.length}/${expectedGames} replays pour le match ${match.id}, nouvelle tentative plus tard`,
      );
      return null;
    }

    const details: BallchasingReplayDetail[] = [];
    for (const summary of summaries) {
      if (!summary.id) continue;
      const detail = await this.get<BallchasingReplayDetail>(
        `${BASE_URL}/replays/${summary.id}`,
        token,
      );
      // Replay encore en cours de traitement : totaux incomplets, on retentera.
      if (!detail || (detail.status && detail.status !== 'ok')) return null;
      details.push(detail);
    }

    const lines = mapBallchasingReplays(details, context.teamA.name, context.teamB.name);
    if (lines.length === 0) {
      this.logger.warn(`Ballchasing : aucune ligne de stats pour le match ${match.id}`);
      return null;
    }
    return {
      lines,
      games: mapBallchasingGames(details, context.teamA.name),
      pageUrl: details[0]?.id ? `https://ballchasing.com/replay/${details[0].id}` : null,
    };
  }

  private async get<T>(url: string, token: string): Promise<T | null> {
    try {
      const response = await politeFetch(url, { headers: { Authorization: token } });
      if (!response.ok) {
        this.logger.warn(`Ballchasing ${url} → ${response.status}`);
        return null;
      }
      return (await response.json()) as T;
    } catch (error) {
      this.logger.warn(`Ballchasing injoignable : ${String(error)}`);
      return null;
    }
  }
}
