import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import type { MapStatsEntry } from '@esfl/contracts';
import type { Match, Prisma } from '../../generated/client';
import { normalizeName, opponentAliasCandidates, OpponentPair, teamMatches, TeamRef } from './matching';
import { politeFetch } from './polite-fetch';
import type {
  GameStatsProvider,
  MatchContext,
  ProviderGameInfo,
  ProviderResult,
  ProviderStatLine,
  StarterRef,
} from './provider';

const BASE_URL = 'https://www.vlr.gg';
const RESULT_PAGES_TO_SCAN = 3;

/** Résultats équipe d'une page de recherche VLR : id + nom affiché. */
export function parseVlrTeamSearch(html: string): Array<{ id: string; name: string }> {
  const $ = cheerio.load(html);
  const out: Array<{ id: string; name: string }> = [];
  $('a.search-item').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const id = href.match(/\/team\/(\d+)\//)?.[1];
    if (!id) return;
    out.push({ id, name: $(el).find('.search-item-title').text().trim() });
  });
  return out;
}

/**
 * Ids d'équipe VLR d'une page match, rattachés au bon côté A/B. Les deux liens
 * `.match-header-link` sont dans l'ordre gauche→droite ; le côté du header
 * gauche est résolu par le nom. Undefined si les deux ids/côtés ne sont pas
 * sûrs (on n'apprend un id que depuis un match clairement résolu).
 */
export function parseVlrMatchTeamIds(
  html: string,
  teamA: TeamRef,
  teamB: TeamRef,
): { A?: string | null; B?: string | null } | undefined {
  const $ = cheerio.load(html);
  const ids: string[] = [];
  $('a.match-header-link').each((_, el) => {
    const id = ($(el).attr('href') ?? '').match(/\/team\/(\d+)\//)?.[1];
    if (id) ids.push(id);
  });
  const names = $('.vm-stats-game-header .team-name')
    .map((_, el) => $(el).text().trim())
    .get();
  if (ids.length < 2 || names.length < 2) return undefined;
  if (teamMatches(names[0], teamA)) return { A: ids[0], B: ids[1] };
  if (teamMatches(names[0], teamB)) return { B: ids[0], A: ids[1] };
  return undefined;
}

/**
 * Titulaires depuis une page équipe VLR : les items de roster **sans rôle**
 * (les remplaçants portent « sub », le staff « coach »/« manager »… → exclus).
 */
export function parseVlrRoster(html: string): StarterRef[] {
  const $ = cheerio.load(html);
  const starters: StarterRef[] = [];
  $('.team-roster-item').each((_, el) => {
    const item = $(el);
    const href = item.find('a[href*="/player/"]').first().attr('href') ?? '';
    const externalId = href.match(/\/player\/(\d+)\//)?.[1];
    if (!externalId) return;
    if (item.find('.team-roster-item-name-role').text().trim()) return;
    const name = item.find('.team-roster-item-name-alias').text().trim();
    if (name) starters.push({ name, externalId });
  });
  return starters;
}

interface VlrRowStats {
  /** Pseudo affiché par VLR (repris dans raw). */
  name: string;
  /** Id joueur VLR (numérique) de la ligne, depuis le lien /player/<id>. */
  externalId: string | null;
  /** Tag d'équipe VLR de la ligne (ex. « 2G ») : sert à résoudre le côté A/B. */
  teamTag: string;
  agent: string | null;
  agentImage: string | null;
  acs: number | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  firstKills: number | null;
  rating: number | null;
  kast: number | null;
  adr: number | null;
  hsPercent: number | null;
  firstDeaths: number | null;
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
 * d'identité vit dans l'ingestion.
 *
 * VLR a remplacé les `<table>` par une grille `.ovw-table` (`.ovw-row` /
 * `.ovw-cell`) : les 10 joueurs sont dans une seule table, groupés par équipe
 * (tag). Colonnes repérées par en-têtes (ACS/FK) ; le K/D/A vit dans une cellule
 * `.ovw-cell.mod-kda` (spans `.ovw-kda-stat[data-col]`).
 */
export function mapVlrMatchHtml(
  html: string,
  teamA: TeamRef,
  teamB: TeamRef,
): ProviderStatLine[] {
  const $ = cheerio.load(html);

  const readBoth = (cell: ReturnType<typeof $> | null): number | null => {
    if (!cell || cell.length === 0) return null;
    const both = cell.find('.side.mod-both').first().text().trim();
    const cleaned = (both || cell.text().trim()).replace(/[^\d.-]/g, '');
    // Cellule vide (map en cours sur une page live) ≠ zéro.
    if (!cleaned) return null;
    const value = Number(cleaned);
    return Number.isFinite(value) ? value : null;
  };

  /**
   * Joueurs d'un bloc .vm-stats-game, par pseudo normalisé. Le bloc contient
   * une grille `.ovw-table` par équipe (chacune avec son en-tête + 5 lignes).
   */
  const parseBlock = (block: ReturnType<typeof $>): Map<string, VlrRowStats> => {
    const rows = new Map<string, VlrRowStats>();
    block.find('.ovw-table').each((_ti, tableEl) => {
      const table = $(tableEl);
      const headers = table
        .find('.ovw-row.mod-head .ovw-th')
        .map((_i, th) => $(th).text().trim().toLowerCase())
        .get();
      const acsCol = headers.findIndex((header) => header === 'acs');
      const fkCol = headers.findIndex((header) => header === 'fk');
      const ratingCol = headers.findIndex((header) => header === 'r');
      const kastCol = headers.findIndex((header) => header === 'kast');
      const adrCol = headers.findIndex((header) => header === 'adr');
      const hsCol = headers.findIndex((header) => header === 'hs%');
      const fdCol = headers.findIndex((header) => header === 'fd');

      table
        .find('.ovw-row')
        .not('.mod-head')
        .each((_rowIdx, row) => {
          const name = $(row).find('.ovw-player-name').first().text().trim();
          if (!name) return;
          const cells = $(row).find('.ovw-cell');
          const cellAt = (index: number) =>
            index >= 0 && index < cells.length ? $(cells[index]) : null;
          const kdaCell = $(row).find('.ovw-cell.mod-kda').first();
          const kdaValue = (col: string): number | null => {
            const text = kdaCell
              .find(`.ovw-kda-stat[data-col="${col}"] .side.mod-both`)
              .first()
              .text()
              .trim();
            const cleaned = text.replace(/[^\d.-]/g, '');
            if (!cleaned) return null;
            const value = Number(cleaned);
            return Number.isFinite(value) ? value : null;
          };
          const agentImg = $(row).find('.mod-agent img').first();
          const agentSrc = agentImg.attr('src') ?? null;

          const playerHref = $(row).find('a[href*="/player/"]').first().attr('href') ?? '';
          rows.set(normalizeName(name), {
            name,
            externalId: playerHref.match(/\/player\/(\d+)\//)?.[1] ?? null,
            teamTag: $(row).find('.ovw-player-tag').first().text().trim(),
            agent: agentImg.attr('title') ?? agentImg.attr('alt') ?? null,
            agentImage: agentSrc
              ? agentSrc.startsWith('/')
                ? `${BASE_URL}${agentSrc}`
                : agentSrc
              : null,
            acs: readBoth(cellAt(acsCol)),
            kills: kdaValue('kills'),
            deaths: kdaValue('deaths'),
            assists: kdaValue('assists'),
            firstKills: readBoth(cellAt(fkCol)),
            rating: readBoth(cellAt(ratingCol)),
            kast: readBoth(cellAt(kastCol)),
            adr: readBoth(cellAt(adrCol)),
            hsPercent: readBoth(cellAt(hsCol)),
            firstDeaths: readBoth(cellAt(fdCol)),
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

  // Côté A/B : les joueurs sont groupés par tag d'équipe et l'équipe de gauche
  // (en-tête .team-name) est listée en premier. Le tag de la 1re ligne = gauche.
  const headerNames = $('.vm-stats-game-header .team-name')
    .map((_i, el) => $(el).text().trim())
    .get();
  const leftIsA = headerNames.length >= 2 ? teamMatches(headerNames[0], teamA) : false;
  const leftIsB = headerNames.length >= 2 ? teamMatches(headerNames[0], teamB) : false;
  const leftTag = aggregate.values().next().value?.teamTag ?? null;
  const sideOf = (teamTag: string): 'A' | 'B' | null => {
    if ((!leftIsA && !leftIsB) || !leftTag) return null;
    const isLeft = teamTag === leftTag;
    return (leftIsA ? isLeft : !isLeft) ? 'A' : 'B';
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
      externalId: stats.externalId,
      side: sideOf(stats.teamTag),
      // Nom d'équipe VLR du joueur (gauche/droite du header) : l'ingestion
      // rattache l'équipe via les joueurs quand le nom ne matche pas le nôtre.
      teamName:
        headerNames.length >= 2
          ? stats.teamTag === leftTag
            ? headerNames[0]
            : headerNames[1]
          : null,
      raw: {
        player: stats.name,
        acs: stats.acs,
        kills: stats.kills,
        deaths: stats.deaths,
        assists: stats.assists,
        firstKills: stats.firstKills,
        firstDeaths: stats.firstDeaths,
        rating: stats.rating,
        kast: stats.kast,
        adr: stats.adr,
        hsPercent: stats.hsPercent,
      } as Prisma.InputJsonValue,
      normalized: {
        kills: stats.kills ?? 0,
        deaths: stats.deaths ?? 0,
        assists: stats.assists ?? 0,
        acs: stats.acs,
        firstKills: stats.firstKills,
        rating: stats.rating,
        kast: stats.kast,
        adr: stats.adr,
        hsPercent: stats.hsPercent,
        firstDeaths: stats.firstDeaths,
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
export function mapVlrGames(html: string): ProviderGameInfo[] {
  const $ = cheerio.load(html);
  const games: ProviderGameInfo[] = [];
  $('.vm-stats-game-header').each((index, header) => {
    const mapName = headerMapName($(header).find('.map').first().text());
    const scores = $(header)
      .find('.score')
      .map((_i, el) => Number($(el).text().trim()))
      .get();
    const names = $(header)
      .find('.team-name')
      .map((_i, el) => $(el).text().trim())
      .get();
    if (names.length < 2 || scores.length < 2) return;
    // Manche non jouée / score absent (non numérique) : on ne l'émet pas.
    if (!Number.isFinite(scores[0]) || !Number.isFinite(scores[1])) return;
    // Scores bruts par nom d'équipe : l'ingestion les rattache aux côtés via les joueurs.
    games.push({
      position: index + 1,
      map: mapName,
      teams: [
        { name: names[0], score: scores[0] },
        { name: names[1], score: scores[1] },
      ],
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
   * Titulaires VLR d'une équipe : recherche du nom → page équipe → joueurs sans
   * rôle (remplaçants/staff exclus). Null si l'équipe n'est pas trouvée avec
   * certitude (nom qui matche) → fallback Pandascore côté ingestion.
   */
  async fetchStarters(
    teamName: string,
    aliases: string[],
    providerTeamId?: string | null,
  ): Promise<StarterRef[] | null> {
    // Id VLR appris depuis un match résolu : on tape directement la bonne page
    // équipe (fiable). Sinon, repli sur la recherche par nom (faillible).
    const teamId = providerTeamId ?? (await this.searchTeamId(teamName, aliases));
    if (!teamId) return null;

    const page = await politeFetch(`${BASE_URL}/team/${teamId}`);
    if (!page.ok) return null;
    const starters = parseVlrRoster(await page.text());
    return starters.length > 0 ? starters : null;
  }

  /** Résolution de secours nom → id VLR par la recherche (peut se tromper d'équipe). */
  private async searchTeamId(teamName: string, aliases: string[]): Promise<string | null> {
    const teamRef: TeamRef = { name: teamName, aliases };
    for (const query of [teamName, ...aliases]) {
      const response = await politeFetch(
        `${BASE_URL}/search/?q=${encodeURIComponent(query)}&type=teams`,
      );
      if (!response.ok) continue;
      const results = parseVlrTeamSearch(await response.text()).filter((result) =>
        teamMatches(result.name, teamRef),
      );
      if (results.length === 0) continue;
      // Égalité exacte de nom préférée à une inclusion (« NAVI » vs « NAVI Junior »).
      const exact = results.find((result) => normalizeName(result.name) === normalizeName(query));
      return (exact ?? results[0]).id;
    }
    return null;
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
      games: mapVlrGames(html),
      pageUrl: matchPath,
      teamIds: parseVlrMatchTeamIds(html, context.teamA, context.teamB),
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

  /** Affiches VLR récentes dont une seule équipe est reconnue (matching manuel). */
  async suggestTeamNames(
    match: Match,
    context: MatchContext,
  ): Promise<Array<{ side: 'A' | 'B'; name: string }>> {
    if (!context.teamA || !context.teamB) return [];
    const pairs: OpponentPair[] = [];
    for (const listing of ['/matches', '/matches/results']) {
      const pages = listing === '/matches/results' ? RESULT_PAGES_TO_SCAN : 1;
      for (let page = 1; page <= pages; page += 1) {
        const response = await politeFetch(`${BASE_URL}${listing}?page=${page}`);
        if (!response.ok) break;
        const $ = cheerio.load(await response.text());
        for (const element of $('a.match-item').toArray()) {
          const names = $(element)
            .find('.match-item-vs-team-name')
            .map((_i, name) => $(name).text().trim())
            .get();
          if (names.length >= 2) pairs.push({ nameA: names[0], nameB: names[1] });
        }
      }
    }
    return opponentAliasCandidates(pairs, context.teamA, context.teamB).map((candidate) => ({
      side: candidate.team,
      name: candidate.alias,
    }));
  }
}
