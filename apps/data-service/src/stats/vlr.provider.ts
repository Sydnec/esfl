import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import type { MapStatsEntry } from '@esfl/contracts';
import type { Match, Prisma } from '../../generated/client';
import { normalizeName, teamMatches, TeamRef } from './matching';
import { politeFetch } from './polite-fetch';
import type {
  GameStatsProvider,
  MatchContext,
  ProviderGameInfo,
  ProviderResult,
  ProviderStatLine,
} from './provider';

const BASE_URL = 'https://www.vlr.gg';
const RESULT_PAGES_TO_SCAN = 3;

interface VlrRowStats {
  /** Pseudo affiché par VLR (repris dans raw). */
  name: string;
  /** Index du tableau dans le bloc : 0 = équipe gauche, 1 = droite. */
  tableIdx: number;
  agent: string | null;
  agentImage: string | null;
  acs: number | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  firstKills: number | null;
}

/** Nom de map d'un en-tête de manche VLR (« Ascent PICK » → « Ascent »). */
function headerMapName(text: string): string | null {
  const name = text.trim().split('\n')[0].replace(/PICK/i, '').trim();
  return name || null;
}

/**
 * Parse la page d'un match VLR.gg : tableau agrégé « all maps » pour
 * normalized, et blocs par manche (agent + KDA de chaque map) pour perMap.
 * Extraction pure (pseudo + côté A/B), sans rapprochement : la résolution
 * d'identité vit dans l'ingestion. Colonnes repérées par les en-têtes
 * ACS/K/D/A/FK pour résister aux réordonnancements mineurs.
 */
export function mapVlrMatchHtml(
  html: string,
  teamA: TeamRef,
  teamB: TeamRef,
): ProviderStatLine[] {
  const $ = cheerio.load(html);

  /** Tableaux joueurs d'un bloc .vm-stats-game, par pseudo normalisé. */
  const parseBlock = (block: ReturnType<typeof $>): Map<string, VlrRowStats> => {
    const rows = new Map<string, VlrRowStats>();
    block.find('table').each((tableIdx, table) => {
      const headers = $(table)
        .find('thead th')
        .map((_i, th) => $(th).text().trim().toLowerCase())
        .get();
      const columnOf = (label: string) => headers.findIndex((header) => header === label);
      const cols = {
        acs: columnOf('acs'),
        kills: columnOf('k'),
        deaths: columnOf('d'),
        assists: columnOf('a'),
        firstKills: columnOf('fk'),
      };
      if (cols.kills < 0 || cols.deaths < 0 || cols.assists < 0) return;

      $(table)
        .find('tbody tr')
        .each((_rowIdx, row) => {
          const name = $(row).find('.mod-player .text-of').first().text().trim();
          if (!name) return;

          const cells = $(row).find('td');
          const readStat = (colIndex: number): number | null => {
            if (colIndex < 0 || colIndex >= cells.length) return null;
            const cell = $(cells[colIndex]);
            const both = cell.find('.side.mod-both').first().text().trim();
            const text = both || cell.text().trim();
            const cleaned = text.replace(/[^\d.-]/g, '');
            // Cellule vide (map en cours sur une page live) ≠ zéro.
            if (!cleaned) return null;
            const value = Number(cleaned);
            return Number.isFinite(value) ? value : null;
          };
          const agentImg = $(row).find('.mod-agent img').first();
          const agentSrc = agentImg.attr('src') ?? null;

          rows.set(normalizeName(name), {
            name,
            tableIdx,
            agent: agentImg.attr('title') ?? agentImg.attr('alt') ?? null,
            agentImage: agentSrc ? (agentSrc.startsWith('/') ? `${BASE_URL}${agentSrc}` : agentSrc) : null,
            acs: readStat(cols.acs),
            kills: readStat(cols.kills),
            deaths: readStat(cols.deaths),
            assists: readStat(cols.assists),
            firstKills: readStat(cols.firstKills),
          });
        });
    });
    return rows;
  };

  const blocks = $('.vm-stats-game').toArray();
  const allBlock = blocks.find((element) => $(element).attr('data-game-id') === 'all');
  if (!allBlock) return [];
  const aggregate = parseBlock($(allBlock));
  if (aggregate.size === 0) return [];

  // Orientation gauche/droite → A/B : le bloc « all » n'a pas d'en-tête
  // d'équipe, on lit celui du premier bloc de manche (même convention que
  // mapVlrGames). Sans en-tête exploitable, side reste null (pas de
  // création de fiche côté ingestion).
  const headerNames = $('.vm-stats-game-header .team-name')
    .map((_i, el) => $(el).text().trim())
    .get();
  const leftIsA = headerNames.length >= 2 ? teamMatches(headerNames[0], teamA) : false;
  const leftIsB = headerNames.length >= 2 ? teamMatches(headerNames[0], teamB) : false;
  const sideOf = (tableIdx: number): 'A' | 'B' | null => {
    if (!leftIsA && !leftIsB) return null;
    if (tableIdx > 1) return null;
    const left = tableIdx === 0;
    return (leftIsA ? left : !left) ? 'A' : 'B';
  };

  // Détail par manche : blocs individuels dans l'ordre du DOM — même
  // convention de position que mapVlrGames.
  const perMapByPlayer = new Map<string, MapStatsEntry[]>();
  blocks
    .filter((element) => $(element).attr('data-game-id') !== 'all')
    .forEach((element, blockIdx) => {
      const block = $(element);
      const mapName = headerMapName(block.find('.vm-stats-game-header .map').first().text());
      for (const [nameKey, stats] of parseBlock(block)) {
        // Manche pas commencée : rien à montrer (VLR rend des cellules
        // vides). Map en cours : l'agent est connu dès le pick, les stats
        // restent nulles jusqu'à la fin de la map — on les garde nulles
        // plutôt que d'afficher de faux zéros.
        const empty =
          stats.kills == null && stats.deaths == null && stats.assists == null;
        if (empty && !stats.agent) continue;
        const entries = perMapByPlayer.get(nameKey) ?? [];
        entries.push({
          position: blockIdx + 1,
          map: mapName,
          agent: stats.agent,
          agentImage: stats.agentImage,
          kills: stats.kills,
          deaths: stats.deaths,
          assists: stats.assists,
          acs: stats.acs,
          firstKills: stats.firstKills,
        });
        perMapByPlayer.set(nameKey, entries);
      }
    });

  const lines: ProviderStatLine[] = [];
  for (const [nameKey, stats] of aggregate) {
    const perMap = perMapByPlayer.get(nameKey);
    lines.push({
      externalName: stats.name,
      side: sideOf(stats.tableIdx),
      raw: {
        player: stats.name,
        acs: stats.acs,
        kills: stats.kills,
        deaths: stats.deaths,
        assists: stats.assists,
        firstKills: stats.firstKills,
      } as Prisma.InputJsonValue,
      normalized: {
        kills: stats.kills ?? 0,
        deaths: stats.deaths ?? 0,
        assists: stats.assists ?? 0,
        acs: stats.acs,
        firstKills: stats.firstKills,
      },
      perMap: perMap?.length ? (perMap as unknown as Prisma.InputJsonValue) : null,
    });
  }
  return lines;
}

/**
 * Manches VLR : chaque bloc « header » de map contient le nom de la map et
 * les scores des deux équipes (gauche = équipe du header principal gauche).
 */
export function mapVlrGames(
  html: string,
  teamA: TeamRef,
  teamB: TeamRef,
): ProviderGameInfo[] {
  const $ = cheerio.load(html);
  const games: ProviderGameInfo[] = [];
  $('.vm-stats-game-header').each((index, header) => {
    const mapName = headerMapName($(header).find('.map').first().text());
    const scores = $(header)
      .find('.score')
      .map((_i, el) => Number($(el).text().trim()))
      .get()
      .filter((value) => Number.isFinite(value));
    const names = $(header)
      .find('.team-name')
      .map((_i, el) => $(el).text().trim())
      .get();
    if (scores.length < 2 || names.length < 2) return;
    const leftIsA = teamMatches(names[0], teamA);
    const leftIsB = teamMatches(names[0], teamB);
    if (!leftIsA && !leftIsB) return;
    games.push({
      position: index + 1,
      map: mapName,
      scoreA: leftIsA ? scores[0] : scores[1],
      scoreB: leftIsA ? scores[1] : scores[0],
    });
  });
  return games;
}

@Injectable()
export class VlrStatsProvider implements GameStatsProvider {
  readonly source = 'vlr';
  readonly gameId = 'valorant' as const;
  private readonly logger = new Logger(VlrStatsProvider.name);

  async fetchStats(match: Match, context: MatchContext): Promise<ProviderResult | null> {
    if (!context.teamA || !context.teamB) return null;

    const matchPath =
      match.statsPageUrl ??
      (await this.findMatchPath(context.teamA, context.teamB, ['/matches/results']));
    if (!matchPath) {
      this.logger.warn(
        `VLR : match ${context.teamA.name} vs ${context.teamB.name} introuvable dans les résultats récents`,
      );
      return null;
    }
    return this.fetchFromPath(matchPath, context);
  }

  /**
   * Stats d'un match en cours : la page est cherchée côté planning/live
   * (un match running n'apparaît pas dans les résultats). Retour null sans
   * bruit si rien n'est encore publié.
   */
  async fetchLiveStats(match: Match, context: MatchContext): Promise<ProviderResult | null> {
    if (!context.teamA || !context.teamB) return null;

    const matchPath =
      match.statsPageUrl ??
      (await this.findMatchPath(context.teamA, context.teamB, ['/matches', '/matches/results']));
    if (!matchPath) return null;
    return this.fetchFromPath(matchPath, context);
  }

  private async fetchFromPath(
    matchPath: string,
    context: MatchContext,
  ): Promise<ProviderResult | null> {
    if (!context.teamA || !context.teamB) return null;
    const response = await politeFetch(`${BASE_URL}${matchPath}`);
    if (!response.ok) {
      this.logger.warn(`VLR ${matchPath} → ${response.status}`);
      return null;
    }
    const html = await response.text();
    const lines = mapVlrMatchHtml(html, context.teamA, context.teamB);
    if (lines.length === 0) {
      return null;
    }
    return {
      lines,
      games: mapVlrGames(html, context.teamA, context.teamB),
      pageUrl: matchPath,
    };
  }

  /** Scanne des listes de matchs VLR et retrouve le lien par noms d'équipes (alias inclus). */
  private async findMatchPath(
    teamA: TeamRef,
    teamB: TeamRef,
    listings: string[],
  ): Promise<string | null> {
    for (const listing of listings) {
      const pages = listing === '/matches/results' ? RESULT_PAGES_TO_SCAN : 1;
      for (let page = 1; page <= pages; page += 1) {
        const response = await politeFetch(`${BASE_URL}${listing}?page=${page}`);
        if (!response.ok) return null;
        const $ = cheerio.load(await response.text());
        const found = $('a.match-item')
          .toArray()
          .find((element) => {
            const names = $(element)
              .find('.match-item-vs-team-name')
              .map((_i, name) => $(name).text().trim())
              .get();
            if (names.length < 2) return false;
            return (
              (teamMatches(names[0], teamA) && teamMatches(names[1], teamB)) ||
              (teamMatches(names[0], teamB) && teamMatches(names[1], teamA))
            );
          });
        if (found) {
          return $(found).attr('href') ?? null;
        }
      }
    }
    return null;
  }
}
