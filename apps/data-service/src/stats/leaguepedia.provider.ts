import { Injectable, Logger } from '@nestjs/common';
import type { Match, Player, Prisma } from '../../generated/client';
import { buildPlayerIndex, matchPlayer, teamNamesMatch } from './matching';
import { politeFetch } from './polite-fetch';
import type { GameStatsProvider, MatchContext, ProviderStatLine } from './provider';

const API_URL = 'https://lol.fandom.com/api.php';

/** Ligne brute cargoquery (join ScoreboardGames + ScoreboardPlayers). */
export interface LeaguepediaRow {
  Link?: string;
  Kills?: string;
  Deaths?: string;
  Assists?: string;
  CS?: string;
  PlayerWin?: string;
  Team?: string;
  Team1?: string;
  Team2?: string;
  Gamelength?: string;
}

/** Retire la désambiguïsation Leaguepedia : "Faker (Lee Sang-hyeok)" → "Faker". */
function stripDisambiguation(link: string): string {
  return link.replace(/\s*\(.*\)$/, '');
}

/**
 * Agrège les games d'un match (Bo3/Bo5) par joueur : K/D/A sommés,
 * csPerMin = CS total / durée totale, win = majorité de games gagnées.
 */
export function mapLeaguepediaRows(
  rows: LeaguepediaRow[],
  teamAName: string,
  teamBName: string,
  players: Player[],
): ProviderStatLine[] {
  const matchRows = rows.filter((row) => {
    const team1 = row.Team1 ?? '';
    const team2 = row.Team2 ?? '';
    return (
      (teamNamesMatch(team1, teamAName) && teamNamesMatch(team2, teamBName)) ||
      (teamNamesMatch(team1, teamBName) && teamNamesMatch(team2, teamAName))
    );
  });
  if (matchRows.length === 0) return [];

  interface Aggregate {
    kills: number;
    deaths: number;
    assists: number;
    cs: number;
    minutes: number;
    wins: number;
    games: number;
    raw: LeaguepediaRow[];
  }
  const byPlayer = new Map<string, Aggregate>();
  for (const row of matchRows) {
    const name = stripDisambiguation(row.Link ?? '');
    if (!name) continue;
    const aggregate = byPlayer.get(name) ?? {
      kills: 0,
      deaths: 0,
      assists: 0,
      cs: 0,
      minutes: 0,
      wins: 0,
      games: 0,
      raw: [],
    };
    aggregate.kills += Number(row.Kills ?? 0);
    aggregate.deaths += Number(row.Deaths ?? 0);
    aggregate.assists += Number(row.Assists ?? 0);
    aggregate.cs += Number(row.CS ?? 0);
    aggregate.minutes += Number(row.Gamelength ?? 0);
    aggregate.wins += row.PlayerWin === 'Yes' ? 1 : 0;
    aggregate.games += 1;
    aggregate.raw.push(row);
    byPlayer.set(name, aggregate);
  }

  const index = buildPlayerIndex(players);
  const lines: ProviderStatLine[] = [];
  for (const [name, aggregate] of byPlayer) {
    const local = matchPlayer(index, name);
    if (!local) continue;
    lines.push({
      playerId: local.id,
      raw: aggregate.raw as unknown as Prisma.InputJsonValue,
      normalized: {
        kills: aggregate.kills,
        deaths: aggregate.deaths,
        assists: aggregate.assists,
        csPerMin: aggregate.minutes > 0 ? Math.round((aggregate.cs / aggregate.minutes) * 100) / 100 : null,
        win: aggregate.wins * 2 > aggregate.games,
      },
    });
  }
  return lines;
}

@Injectable()
export class LeaguepediaStatsProvider implements GameStatsProvider {
  readonly source = 'leaguepedia';
  readonly gameId = 'lol' as const;
  private readonly logger = new Logger(LeaguepediaStatsProvider.name);

  async fetchStats(match: Match, context: MatchContext): Promise<ProviderStatLine[] | null> {
    if (!context.teamA || !context.teamB) return null;
    const reference = match.beginAt ?? match.scheduledAt;
    if (!reference) return null;

    const from = new Date(reference.getTime() - 24 * 3600 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    const to = new Date(reference.getTime() + 24 * 3600 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

    const url = new URL(API_URL);
    url.searchParams.set('action', 'cargoquery');
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '500');
    url.searchParams.set('tables', 'ScoreboardGames=SG,ScoreboardPlayers=SP');
    url.searchParams.set('join_on', 'SG.GameId=SP.GameId');
    url.searchParams.set(
      'fields',
      'SP.Link,SP.Kills,SP.Deaths,SP.Assists,SP.CS,SP.PlayerWin,SP.Team,SG.Team1,SG.Team2,SG.Gamelength Number=Gamelength',
    );
    url.searchParams.set(
      'where',
      `SG.DateTime_UTC >= '${from}' AND SG.DateTime_UTC <= '${to}'`,
    );

    // Fandom rate-limite agressivement les requêtes anonymes : 10 s entre appels.
    const response = await politeFetch(url, {}, 10_000);
    if (!response.ok) {
      this.logger.warn(`Leaguepedia → ${response.status}`);
      return null;
    }
    const payload = (await response.json()) as {
      cargoquery?: Array<{ title: LeaguepediaRow }>;
      error?: unknown;
    };
    if (payload.error) {
      this.logger.warn(`Leaguepedia cargoquery en erreur : ${JSON.stringify(payload.error)}`);
      return null;
    }
    const rows = (payload.cargoquery ?? []).map((entry) => entry.title);
    const lines = mapLeaguepediaRows(rows, context.teamA.name, context.teamB.name, context.players);
    if (lines.length === 0) {
      this.logger.warn(
        `Leaguepedia : rien trouvé pour ${context.teamA.name} vs ${context.teamB.name}`,
      );
      return null;
    }
    return lines;
  }
}
