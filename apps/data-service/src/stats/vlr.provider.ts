import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import type { Match, Player, Prisma } from '../../generated/client';
import { buildPlayerIndex, matchPlayer, teamNamesMatch } from './matching';
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

/**
 * Parse la page d'un match VLR.gg : tableau de stats « both maps »
 * (colonnes repérées par les en-têtes ACS/K/D/A/FK pour résister aux
 * réordonnancements mineurs). Exporté pur pour les tests sur fixture HTML.
 */
export function mapVlrMatchHtml(html: string, players: Player[]): ProviderStatLine[] {
  const $ = cheerio.load(html);
  const index = buildPlayerIndex(players);
  const lines: ProviderStatLine[] = [];

  const statsRoot = $('.vm-stats-game[data-game-id="all"]');
  if (statsRoot.length === 0) return [];

  statsRoot.find('table').each((_tableIdx, table) => {
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
        const local = matchPlayer(index, name);
        if (!local) return;

        const cells = $(row).find('td');
        const readStat = (colIndex: number): number | null => {
          if (colIndex < 0 || colIndex >= cells.length) return null;
          const cell = $(cells[colIndex]);
          const both = cell.find('.side.mod-both').first().text().trim();
          const text = both || cell.text().trim();
          const value = Number(text.replace(/[^\d.-]/g, ''));
          return Number.isFinite(value) ? value : null;
        };

        lines.push({
          playerId: local.id,
          raw: {
            player: name,
            acs: readStat(cols.acs),
            kills: readStat(cols.kills),
            deaths: readStat(cols.deaths),
            assists: readStat(cols.assists),
            firstKills: readStat(cols.firstKills),
          } as Prisma.InputJsonValue,
          normalized: {
            kills: readStat(cols.kills) ?? 0,
            deaths: readStat(cols.deaths) ?? 0,
            assists: readStat(cols.assists) ?? 0,
            acs: readStat(cols.acs),
            firstKills: readStat(cols.firstKills),
          },
        });
      });
  });
  return lines;
}

/**
 * Manches VLR : chaque bloc « header » de map contient le nom de la map et
 * les scores des deux équipes (gauche = équipe du header principal gauche).
 */
export function mapVlrGames(
  html: string,
  teamAName: string,
  teamBName: string,
): ProviderGameInfo[] {
  const $ = cheerio.load(html);
  const games: ProviderGameInfo[] = [];
  $('.vm-stats-game-header').each((index, header) => {
    const mapName = $(header)
      .find('.map')
      .first()
      .text()
      .trim()
      .split('\n')[0]
      .replace(/PICK/i, '')
      .trim();
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
    const leftIsA = teamNamesMatch(names[0], teamAName);
    const leftIsB = teamNamesMatch(names[0], teamBName);
    if (!leftIsA && !leftIsB) return;
    games.push({
      position: index + 1,
      map: mapName || null,
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

    const matchPath = await this.findMatchPath(context.teamA.name, context.teamB.name);
    if (!matchPath) {
      this.logger.warn(
        `VLR : match ${context.teamA.name} vs ${context.teamB.name} introuvable dans les résultats récents`,
      );
      return null;
    }

    const response = await politeFetch(`${BASE_URL}${matchPath}`);
    if (!response.ok) {
      this.logger.warn(`VLR ${matchPath} → ${response.status}`);
      return null;
    }
    const html = await response.text();
    const lines = mapVlrMatchHtml(html, context.players);
    if (lines.length === 0) {
      this.logger.warn(`VLR : structure de page inattendue ou aucun joueur rapproché (${matchPath})`);
      return null;
    }
    return { lines, games: mapVlrGames(html, context.teamA.name, context.teamB.name) };
  }

  /** Scanne les pages de résultats récents et retrouve le lien du match par noms d'équipes. */
  private async findMatchPath(teamAName: string, teamBName: string): Promise<string | null> {
    for (let page = 1; page <= RESULT_PAGES_TO_SCAN; page += 1) {
      const response = await politeFetch(`${BASE_URL}/matches/results?page=${page}`);
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
            (teamNamesMatch(names[0], teamAName) && teamNamesMatch(names[1], teamBName)) ||
            (teamNamesMatch(names[0], teamBName) && teamNamesMatch(names[1], teamAName))
          );
        });
      if (found) {
        return $(found).attr('href') ?? null;
      }
    }
    return null;
  }
}
