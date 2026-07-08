import { Injectable, Logger } from '@nestjs/common';
import type { Match, Player, Prisma } from '../../generated/client';
import { buildPlayerIndex, matchPlayer, teamNamesMatch } from './matching';
import { politeFetch } from './polite-fetch';
import type { GameStatsProvider, MatchContext, ProviderStatLine } from './provider';

const BASE_URL = 'https://zsr.octane.gg';

export interface OctaneSide {
  team?: { team?: { name?: string } };
  players?: Array<{
    player?: { tag?: string };
    stats?: {
      core?: { goals?: number; assists?: number; saves?: number; shots?: number; score?: number };
    };
  }>;
}

export interface OctaneMatch {
  _id?: string;
  date?: string;
  blue?: OctaneSide;
  orange?: OctaneSide;
}

export function findOctaneMatch(
  matches: OctaneMatch[],
  teamAName: string,
  teamBName: string,
): OctaneMatch | null {
  return (
    matches.find((candidate) => {
      const blue = candidate.blue?.team?.team?.name ?? '';
      const orange = candidate.orange?.team?.team?.name ?? '';
      return (
        (teamNamesMatch(blue, teamAName) && teamNamesMatch(orange, teamBName)) ||
        (teamNamesMatch(blue, teamBName) && teamNamesMatch(orange, teamAName))
      );
    }) ?? null
  );
}

/** Agrège les stats cœur du match Octane sur nos joueurs locaux. */
export function mapOctaneMatch(octaneMatch: OctaneMatch, players: Player[]): ProviderStatLine[] {
  const index = buildPlayerIndex(players);
  const lines: ProviderStatLine[] = [];
  for (const side of [octaneMatch.blue, octaneMatch.orange]) {
    for (const entry of side?.players ?? []) {
      const tag = entry.player?.tag;
      if (!tag) continue;
      const local = matchPlayer(index, tag);
      if (!local) continue;
      const core = entry.stats?.core ?? {};
      lines.push({
        playerId: local.id,
        raw: entry as unknown as Prisma.InputJsonValue,
        normalized: {
          goals: core.goals ?? 0,
          assists: core.assists ?? 0,
          saves: core.saves ?? 0,
          shots: core.shots ?? 0,
          score: core.score ?? null,
        },
      });
    }
  }
  return lines;
}

@Injectable()
export class OctaneStatsProvider implements GameStatsProvider {
  readonly source = 'octane';
  readonly gameId = 'rl' as const;
  private readonly logger = new Logger(OctaneStatsProvider.name);

  async fetchStats(match: Match, context: MatchContext): Promise<ProviderStatLine[] | null> {
    if (!context.teamA || !context.teamB) return null;
    const reference = match.beginAt ?? match.scheduledAt;
    if (!reference) return null;

    const after = new Date(reference.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    const before = new Date(reference.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    const url = `${BASE_URL}/matches?after=${after}&before=${before}&perPage=200`;
    const response = await politeFetch(url);
    if (!response.ok) {
      this.logger.warn(`Octane ${url} → ${response.status}`);
      return null;
    }
    const payload = (await response.json()) as { matches?: OctaneMatch[] };
    const found = findOctaneMatch(payload.matches ?? [], context.teamA.name, context.teamB.name);
    if (!found) {
      this.logger.warn(
        `Octane : match ${context.teamA.name} vs ${context.teamB.name} (${after}) introuvable`,
      );
      return null;
    }
    const lines = mapOctaneMatch(found, context.players);
    if (lines.length === 0) {
      this.logger.warn(`Octane : aucun joueur rapproché pour le match ${match.id}`);
      return null;
    }
    return lines;
  }
}
