import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Match, Prisma, Team } from '../../generated/client';
import { PrismaService } from '../prisma.service';
import { inferOpponentAlias, normalizeName, TeamRef, teamMatches } from './matching';
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
    boost?: { bpm?: number; bcpm?: number };
    demo?: { inflicted?: number; taken?: number };
  };
}

export interface BallchasingReplayDetail {
  id?: string;
  status?: string;
  date?: string;
  map_name?: string;
  // Buts d'équipe : `goals` dans le listing, `stats.core.goals` dans le détail.
  blue?: {
    name?: string;
    goals?: number;
    players?: BallchasingPlayer[];
    stats?: { core?: { goals?: number } };
  };
  orange?: {
    name?: string;
    goals?: number;
    players?: BallchasingPlayer[];
    stats?: { core?: { goals?: number } };
  };
}

/** Deux uploads d'une même manche : même map, mêmes scores, départs à < 2 min
 * (chaque client enregistre son propre replay — les ids diffèrent, pas la
 * partie ; une vraie manche dure > 5 min, pas de faux positif possible). */
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

function isSameGame(a: BallchasingReplaySummary, b: BallchasingReplaySummary): boolean {
  if ((a.map_name ?? null) !== (b.map_name ?? null)) return false;
  if ((a.blue?.goals ?? 0) !== (b.blue?.goals ?? 0)) return false;
  if ((a.orange?.goals ?? 0) !== (b.orange?.goals ?? 0)) return false;
  const timeA = a.date ? Date.parse(a.date) : NaN;
  const timeB = b.date ? Date.parse(b.date) : NaN;
  if (Number.isNaN(timeA) || Number.isNaN(timeB)) return false;
  return Math.abs(timeA - timeB) < DUPLICATE_WINDOW_MS;
}

/**
 * Replays d'une série : les deux noms d'équipes doivent correspondre, et une
 * même manche uploadée par plusieurs comptes (staff des deux équipes,
 * arbitre…) ne compte qu'une fois.
 */
export function findBallchasingReplays(
  replays: BallchasingReplaySummary[],
  teamA: TeamRef,
  teamB: TeamRef,
): BallchasingReplaySummary[] {
  const kept: BallchasingReplaySummary[] = [];
  const sorted = [...replays].sort(
    (a, b) => (a.date ? Date.parse(a.date) : 0) - (b.date ? Date.parse(b.date) : 0),
  );
  for (const replay of sorted) {
    const blue = replay.blue?.name ?? '';
    const orange = replay.orange?.name ?? '';
    const bothMatch =
      (teamMatches(blue, teamA) && teamMatches(orange, teamB)) ||
      (teamMatches(blue, teamB) && teamMatches(orange, teamA));
    if (!bothMatch) continue;
    if (kept.some((existing) => isSameGame(existing, replay))) continue;
    kept.push(replay);
  }
  return kept;
}

/**
 * Agrège les replays d'une série (un replay = une manche) en stats par
 * joueur : les compteurs sont sommés, le côté bleu/orange étant résolu par
 * noms d'équipes replay par replay (les couleurs peuvent s'inverser).
 */
export function mapBallchasingReplays(
  replays: BallchasingReplayDetail[],
  teamA: TeamRef,
  teamB: TeamRef,
): ProviderStatLine[] {
  const byPlayer = new Map<
    string,
    {
      externalName: string;
      side: 'A' | 'B' | null;
      teamName: string | null;
      core: Record<string, number>;
      demos: number;
      demosTaken: number;
      bpmSum: number;
      bcpmSum: number;
      games: number;
    }
  >();

  for (const replay of replays) {
    for (const teamSide of [replay.blue, replay.orange]) {
      const side = teamMatches(teamSide?.name ?? '', teamA)
        ? 'A'
        : teamMatches(teamSide?.name ?? '', teamB)
          ? 'B'
          : null;
      for (const entry of teamSide?.players ?? []) {
        if (!entry.name) continue;
        const key = normalizeName(entry.name);
        const core = entry.stats?.core ?? {};
        const acc = byPlayer.get(key) ?? {
          externalName: entry.name,
          side,
          teamName: teamSide?.name ?? null,
          core: { goals: 0, assists: 0, saves: 0, shots: 0, score: 0 },
          demos: 0,
          demosTaken: 0,
          bpmSum: 0,
          bcpmSum: 0,
          games: 0,
        };
        acc.side = acc.side ?? side;
        acc.core.goals += core.goals ?? 0;
        acc.core.assists += core.assists ?? 0;
        acc.core.saves += core.saves ?? 0;
        acc.core.shots += core.shots ?? 0;
        acc.core.score += core.score ?? 0;
        acc.demos += entry.stats?.demo?.inflicted ?? 0;
        acc.demosTaken += entry.stats?.demo?.taken ?? 0;
        acc.bpmSum += entry.stats?.boost?.bpm ?? 0;
        acc.bcpmSum += entry.stats?.boost?.bcpm ?? 0;
        acc.games += 1;
        byPlayer.set(key, acc);
      }
    }
  }

  return Array.from(byPlayer.values())
    // Un score série de 0 est impossible pour un joueur réel : c'est un
    // spectateur dans le lobby (arbitre RLCS notamment), pas un participant.
    .filter((acc) => acc.core.score > 0 || acc.core.shots > 0 || acc.core.saves > 0)
    .map((acc) => ({
      externalName: acc.externalName,
      side: acc.side,
      teamName: acc.teamName,
      raw: { games: acc.games, demos: acc.demos, ...acc.core } as unknown as Prisma.InputJsonValue,
      normalized: {
        goals: acc.core.goals,
        assists: acc.core.assists,
        saves: acc.core.saves,
        shots: acc.core.shots,
        score: acc.core.score,
        demosInflicted: acc.demos,
        boostBpm: acc.games > 0 ? Math.round(acc.bpmSum / acc.games) : null,
        // Précision agrégée (buts/tirs) plutôt que moyenne des % par manche.
        shootingPct: acc.core.shots > 0 ? Math.round((acc.core.goals / acc.core.shots) * 1000) / 1000 : null,
        bcpm: acc.games > 0 ? Math.round(acc.bcpmSum / acc.games) : null,
        demosTaken: acc.demosTaken,
      },
    }));
}

/** Manches de la série : score par manche, côté A/B résolu par noms d'équipes. */
export function mapBallchasingGames(
  replays: BallchasingReplayDetail[],
  teamA: TeamRef,
): Array<{ position: number; map: string | null; scoreA: number | null; scoreB: number | null }> {
  return replays.map((replay, index) => {
    const blueIsA = teamMatches(replay.blue?.name ?? '', teamA);
    const blueGoals = replay.blue?.stats?.core?.goals ?? replay.blue?.goals ?? null;
    const orangeGoals = replay.orange?.stats?.core?.goals ?? replay.orange?.goals ?? null;
    return {
      position: index + 1,
      map: replay.map_name ?? null,
      scoreA: blueIsA ? blueGoals : orangeGoals,
      scoreB: blueIsA ? orangeGoals : blueGoals,
    };
  });
}

@Injectable()
export class BallchasingStatsProvider implements GameStatsProvider {
  readonly source = 'ballchasing';
  readonly gameId = 'rl' as const;
  private readonly logger = new Logger(BallchasingStatsProvider.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

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

    let summaries = findBallchasingReplays(listing.list ?? [], context.teamA, context.teamB);
    if (summaries.length === 0) {
      // Corrélation par l'adversaire : une seule équipe reconnue dans la
      // fenêtre → le nom d'en face est appris comme alias, puis on refiltre.
      const pairs = (listing.list ?? []).map((replay) => ({
        nameA: replay.blue?.name ?? '',
        nameB: replay.orange?.name ?? '',
      }));
      const inferred = inferOpponentAlias(pairs, context.teamA, context.teamB);
      // Garde-fou : un nom déjà connu comme équipe est une vraie équipe tierce,
      // pas un alias de la nôtre — on ne l'apprend pas (cf. Grid).
      if (inferred && !(await this.isKnownTeam(inferred.alias))) {
        const target = inferred.team === 'A' ? context.teamA : context.teamB;
        await this.learnAlias(target, inferred.alias);
        summaries = findBallchasingReplays(listing.list ?? [], context.teamA, context.teamB);
      }
    }
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

    const lines = mapBallchasingReplays(details, context.teamA, context.teamB);
    if (lines.length === 0) {
      this.logger.warn(`Ballchasing : aucune ligne de stats pour ${match.name}`);
      return null;
    }
    return {
      lines,
      games: mapBallchasingGames(details, context.teamA),
      pageUrl: details[0]?.id ? `https://ballchasing.com/replay/${details[0].id}` : null,
    };
  }

  /** Persiste un alias appris et met à jour l'objet en mémoire (contexte du fetch en cours). */
  private async learnAlias(team: Team, alias: string): Promise<void> {
    await this.prisma.team.update({
      where: { id: team.id },
      data: { aliases: { push: alias } },
    });
    team.aliases = [...(team.aliases ?? []), alias];
    this.logger.log(`Alias appris via ballchasing : « ${alias} » → ${team.name}`);
  }

  /** Vrai si un nom correspond (forme normalisée) à une équipe RL déjà connue. */
  private async isKnownTeam(name: string): Promise<boolean> {
    const normalized = normalizeName(name);
    if (!normalized) return false;
    const teams = await this.prisma.team.findMany({
      where: { gameId: this.gameId },
      select: { name: true },
    });
    return teams.some((team) => normalizeName(team.name) === normalized);
  }

  private async get<T>(url: string, token: string): Promise<T | null> {
    try {
      // Free tier ballchasing : 2 req/s → 500 ms d'espacement (au lieu du défaut 1 s).
      const response = await politeFetch(url, { headers: { Authorization: token } }, 500);
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
