import { Injectable, Logger } from '@nestjs/common';
import type { MapStatsEntry } from '@esfl/contracts';
import type { Match, Prisma } from '../../generated/client';
import { teamMatches, TeamRef } from './matching';
import { politeFetch } from './polite-fetch';
import type {
  GameStatsProvider,
  MatchContext,
  ProviderGameInfo,
  ProviderResult,
  ProviderStatLine,
} from './provider';

const API_URL = 'https://lol.fandom.com/api.php';

/** Ligne brute cargoquery (join ScoreboardGames + ScoreboardPlayers). */
export interface LeaguepediaRow {
  Link?: string;
  Champion?: string;
  Kills?: string;
  Deaths?: string;
  Assists?: string;
  CS?: string;
  PlayerWin?: string;
  Team?: string;
  Team1?: string;
  Team2?: string;
  Gamelength?: string;
  GameId?: string;
  GameNumber?: string;
}

/** Retire la désambiguïsation Leaguepedia : "Faker (Lee Sang-hyeok)" → "Faker". */
function stripDisambiguation(link: string): string {
  return link.replace(/\s*\(.*\)$/, '');
}

/** Ids Data Dragon qui ne se déduisent pas du nom affiché. */
const CHAMPION_ID_EXCEPTIONS: Record<string, string> = {
  Wukong: 'MonkeyKing',
  'Renata Glasc': 'Renata',
  'Nunu & Willump': 'Nunu',
};

/**
 * Icône de champion via CommunityDragon (CDN Riot communautaire prévu pour
 * le hotlinking, version « latest » gérée côté CDN).
 */
export function championImageUrl(champion: string): string {
  const id = CHAMPION_ID_EXCEPTIONS[champion] ?? champion.replace(/[^a-zA-Z]/g, '');
  return `https://cdn.communitydragon.org/latest/champion/${id}/square`;
}

/**
 * Agrège les games d'un match (Bo3/Bo5) par joueur : K/D/A sommés,
 * csPerMin = CS total / durée totale, win = majorité de games gagnées.
 */
export function mapLeaguepediaRows(
  rows: LeaguepediaRow[],
  teamA: TeamRef,
  teamB: TeamRef,
): ProviderStatLine[] {
  const matchRows = rows.filter((row) => {
    const team1 = row.Team1 ?? '';
    const team2 = row.Team2 ?? '';
    return (
      (teamMatches(team1, teamA) && teamMatches(team2, teamB)) ||
      (teamMatches(team1, teamB) && teamMatches(team2, teamA))
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
    team: string | null;
    raw: LeaguepediaRow[];
    perMap: MapStatsEntry[];
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
      team: null,
      raw: [],
      perMap: [],
    };
    aggregate.team = aggregate.team ?? row.Team ?? null;
    aggregate.kills += Number(row.Kills ?? 0);
    aggregate.deaths += Number(row.Deaths ?? 0);
    aggregate.assists += Number(row.Assists ?? 0);
    aggregate.cs += Number(row.CS ?? 0);
    aggregate.minutes += Number(row.Gamelength ?? 0);
    aggregate.wins += row.PlayerWin === 'Yes' ? 1 : 0;
    aggregate.games += 1;
    aggregate.raw.push(row);
    // Détail de la game : champion + stats (pas de map en LoL).
    const gameMinutes = Number(row.Gamelength ?? 0);
    aggregate.perMap.push({
      position: Number(row.GameNumber ?? 0) || aggregate.games,
      map: null,
      agent: row.Champion ?? null,
      agentImage: row.Champion ? championImageUrl(row.Champion) : null,
      kills: Number(row.Kills ?? 0),
      deaths: Number(row.Deaths ?? 0),
      assists: Number(row.Assists ?? 0),
      csPerMin:
        gameMinutes > 0 ? Math.round((Number(row.CS ?? 0) / gameMinutes) * 100) / 100 : null,
      win: row.PlayerWin === 'Yes',
    });
    byPlayer.set(name, aggregate);
  }

  const lines: ProviderStatLine[] = [];
  for (const [name, aggregate] of byPlayer) {
    const side = teamMatches(aggregate.team ?? '', teamA)
      ? 'A'
      : teamMatches(aggregate.team ?? '', teamB)
        ? 'B'
        : null;
    lines.push({
      externalName: name,
      side,
      raw: aggregate.raw as unknown as Prisma.InputJsonValue,
      normalized: {
        kills: aggregate.kills,
        deaths: aggregate.deaths,
        assists: aggregate.assists,
        csPerMin: aggregate.minutes > 0 ? Math.round((aggregate.cs / aggregate.minutes) * 100) / 100 : null,
        win: aggregate.wins * 2 > aggregate.games,
      },
      perMap: aggregate.perMap.sort((a, b) => a.position - b.position) as unknown as Prisma.InputJsonValue,
    });
  }
  return lines;
}

/** Manches LoL : « score » = total de kills de chaque équipe sur la game. */
export function mapLeaguepediaGames(
  rows: LeaguepediaRow[],
  teamA: TeamRef,
  teamB: TeamRef,
): ProviderGameInfo[] {
  const matchRows = rows.filter((row) => {
    const team1 = row.Team1 ?? '';
    const team2 = row.Team2 ?? '';
    return (
      (teamMatches(team1, teamA) && teamMatches(team2, teamB)) ||
      (teamMatches(team1, teamB) && teamMatches(team2, teamA))
    );
  });
  const byGame = new Map<string, LeaguepediaRow[]>();
  for (const row of matchRows) {
    const key = row.GameId ?? `${row.GameNumber ?? '?'}`;
    byGame.set(key, [...(byGame.get(key) ?? []), row]);
  }
  const games: ProviderGameInfo[] = [];
  let fallbackPosition = 0;
  for (const gameRows of byGame.values()) {
    fallbackPosition += 1;
    const killsFor = (team: TeamRef) =>
      gameRows
        .filter((row) => teamMatches(row.Team ?? '', team))
        .reduce((sum, row) => sum + Number(row.Kills ?? 0), 0);
    games.push({
      position: Number(gameRows[0].GameNumber ?? fallbackPosition) || fallbackPosition,
      map: null,
      scoreA: killsFor(teamA),
      scoreB: killsFor(teamB),
    });
  }
  return games.sort((a, b) => a.position - b.position);
}

@Injectable()
export class LeaguepediaStatsProvider implements GameStatsProvider {
  readonly source = 'leaguepedia';
  readonly gameId = 'lol' as const;
  private readonly logger = new Logger(LeaguepediaStatsProvider.name);

  async fetchStats(match: Match, context: MatchContext): Promise<ProviderResult | null> {
    if (!context.teamA || !context.teamB) return null;
    const reference = match.beginAt ?? match.scheduledAt;
    if (!reference) return null;

    // Fenêtre ±12h : assez large pour les décalages de planning, assez
    // étroite pour limiter le volume (la fenêtre ramène TOUS les matchs
    // LoL de la période, le filtrage par équipes est côté client).
    const from = new Date(reference.getTime() - 12 * 3600 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    const to = new Date(reference.getTime() + 12 * 3600 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

    const url = new URL(API_URL);
    url.searchParams.set('action', 'cargoquery');
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '500');
    url.searchParams.set('tables', 'ScoreboardGames=SG,ScoreboardPlayers=SP');
    url.searchParams.set('join_on', 'SG.GameId=SP.GameId');
    // NB : les noms de champs Cargo utilisent des underscores (« Gamelength Number »
    // → Gamelength_Number) ; un espace provoque une MWException côté Fandom.
    url.searchParams.set(
      'fields',
      'SP.Link,SP.Champion,SP.Kills,SP.Deaths,SP.Assists,SP.CS,SP.PlayerWin,SP.Team,SG.Team1,SG.Team2,SG.Gamelength_Number=Gamelength,SG.GameId=GameId,SG.N_GameInMatch=GameNumber',
    );
    url.searchParams.set(
      'where',
      `SG.DateTime_UTC >= '${from}' AND SG.DateTime_UTC <= '${to}'`,
    );

    // Cargo tronque à 500 lignes : pagination par offset (les journées
    // chargées dépassent 500 lignes joueur×game et faisaient disparaître
    // des joueurs du match), 3 pages maximum.
    const rows: LeaguepediaRow[] = [];
    for (let offset = 0; offset < 1500; offset += 500) {
      url.searchParams.set('offset', String(offset));
      // Fandom rate-limite les bursts anonymes : ~2 requêtes/minute max,
      // pagination comprise.
      const response = await politeFetch(url, {}, 35_000);
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
      const page = (payload.cargoquery ?? []).map((entry) => entry.title);
      rows.push(...page);
      if (page.length < 500) break;
    }
    const lines = mapLeaguepediaRows(rows, context.teamA, context.teamB);
    if (lines.length === 0) {
      this.logger.warn(
        `Leaguepedia : rien trouvé pour ${context.teamA.name} vs ${context.teamB.name}`,
      );
      return null;
    }
    return {
      lines,
      games: mapLeaguepediaGames(rows, context.teamA, context.teamB),
    };
  }
}
