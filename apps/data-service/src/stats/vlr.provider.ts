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
  TeamProfile,
  TeamSearchResult,
} from './provider';

const BASE_URL = 'https://www.vlr.gg';
const RESULT_PAGES_TO_SCAN = 3;
/**
 * Tolérance entre la date du listing VLR (jour local du site) et notre date de
 * match (UTC Pandascore) : 36h couvrent fuseaux et matchs à cheval sur minuit,
 * tout en écartant les rediffusions d'un même matchup à plusieurs jours d'écart.
 */
const LISTING_DATE_SLACK_MS = 36 * 3600 * 1000;

/** Entrée d'un listing de matchs VLR (résultats ou planning). */
export interface VlrListingMatch {
  href: string;
  names: string[];
  scores: Array<number | null>;
  /** Jour du groupe de listing (en-tête wf-label au-dessus des cartes). */
  date: Date | null;
}

/**
 * Parse un listing VLR (/matches, /matches/results) en gardant le jour de
 * chaque affiche : les cartes sont groupées sous des en-têtes de date. Sans ce
 * jour, deux rencontres d'un même matchup (NRG vs 100T joué 5 fois) sont
 * indistinguables par les noms seuls.
 */
export function parseVlrMatchListing(html: string): VlrListingMatch[] {
  const $ = cheerio.load(html);
  const out: VlrListingMatch[] = [];
  let currentDate: Date | null = null;
  $('.wf-label.mod-large, a.match-item').each((_, element) => {
    const node = $(element);
    if (node.hasClass('wf-label')) {
      // « Sat, July 12, 2026 (Today) » → date parseable, mentions relatives retirées.
      const text = node
        .text()
        .replace(/today|yesterday|tomorrow/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      const parsed = Date.parse(text);
      currentDate = Number.isNaN(parsed) ? null : new Date(parsed);
      return;
    }
    const names = node
      .find('.match-item-vs-team-name')
      .map((_i, name) => $(name).text().trim())
      .get();
    const scores = node
      .find('.match-item-vs-team-score')
      .map((_i, score) => {
        const value = Number($(score).text().trim());
        return Number.isFinite(value) ? value : null;
      })
      .get();
    const href = node.attr('href');
    if (href && names.length >= 2) out.push({ href, names, scores, date: currentDate });
  });
  return out;
}

/** Entrée de l'historique de matchs d'une équipe VLR (/team/matches/<id>). */
export interface VlrTeamMatchItem {
  href: string;
  /** [équipe de la page, adversaire]. */
  names: string[];
  /** Score de l'équipe de la page puis de l'adversaire. */
  scores: Array<number | null>;
  /** Jour du match (heure ignorée : la tolérance de date couvre les fuseaux). */
  date: Date | null;
}

/**
 * Parse l'historique de matchs d'une équipe (/team/matches/<id>/?group=completed) :
 * anté-chronologique, ~50 affiches par page, chacune datée et scorée — le seul
 * endroit où retrouver la page d'un match trop ancien pour les listings récents.
 */
export function parseVlrTeamMatches(html: string): VlrTeamMatchItem[] {
  const $ = cheerio.load(html);
  const out: VlrTeamMatchItem[] = [];
  $('a.m-item')
    .not('.m-item-games-item')
    .each((_, element) => {
      const item = $(element);
      const href = item.attr('href');
      if (!href) return;
      const names = item
        .find('.m-item-team-name')
        .map((_i, name) => $(name).text().replace(/\s+/g, ' ').trim())
        .get();
      const result = item.find('.m-item-result').text().replace(/\s+/g, ' ').trim();
      const scoreMatch = result.match(/(\d+)\s*:\s*(\d+)/);
      const scores: Array<number | null> = scoreMatch
        ? [Number(scoreMatch[1]), Number(scoreMatch[2])]
        : [null, null];
      // « 2026/05/31 2:00 am » → jour UTC (l'heure locale du site est ignorée).
      const day = item
        .find('.m-item-date')
        .text()
        .match(/(\d{4})\/(\d{2})\/(\d{2})/);
      const date = day ? new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]))) : null;
      if (names.length >= 2) out.push({ href, names, scores, date });
    });
  return out;
}

/**
 * Sélectionne dans l'historique d'une équipe l'affiche correspondant au match
 * attendu : adversaire reconnu, jour dans la tolérance (obligatoire ici — les
 * matchups se répètent dans un historique long) et score orienté quand connu.
 */
export function pickVlrTeamHistoryMatch(
  items: VlrTeamMatchItem[],
  opponent: TeamRef,
  expected: { reference: Date; ownScore?: number | null; oppScore?: number | null },
): string | null {
  for (const item of items) {
    if (!teamMatches(item.names[1] ?? '', opponent)) continue;
    if (!item.date) continue;
    if (Math.abs(item.date.getTime() - expected.reference.getTime()) > LISTING_DATE_SLACK_MS) {
      continue;
    }
    if (
      expected.ownScore != null &&
      expected.oppScore != null &&
      item.scores[0] != null &&
      item.scores[1] != null &&
      (item.scores[0] !== expected.ownScore || item.scores[1] !== expected.oppScore)
    ) {
      continue;
    }
    return item.href;
  }
  return null;
}

/** Critères de confirmation d'une affiche du listing (matchup répété). */
export interface VlrMatchExpectation {
  /** Date du match chez nous (beginAt/scheduledAt). */
  reference?: Date | null;
  /** Score global attendu (matchs finis uniquement). */
  scoreA?: number | null;
  scoreB?: number | null;
}

/**
 * Vrai si une entrée de listing correspond au match attendu : les deux noms
 * matchent, le jour du listing colle à notre date (± tolérance) et, quand le
 * score global est connu des deux côtés, il coïncide dans la bonne orientation.
 * Les critères indisponibles (date de groupe illisible, score absent) ne
 * bloquent pas : on dégrade vers le comportement historique.
 */
export function vlrListingEntryMatches(
  entry: VlrListingMatch,
  teamA: TeamRef,
  teamB: TeamRef,
  expected?: VlrMatchExpectation,
): boolean {
  const forward = teamMatches(entry.names[0], teamA) && teamMatches(entry.names[1], teamB);
  const reverse = teamMatches(entry.names[0], teamB) && teamMatches(entry.names[1], teamA);
  if (!forward && !reverse) return false;
  if (expected?.reference && entry.date) {
    if (Math.abs(entry.date.getTime() - expected.reference.getTime()) > LISTING_DATE_SLACK_MS) {
      return false;
    }
  }
  if (
    expected &&
    expected.scoreA != null &&
    expected.scoreB != null &&
    entry.scores.length >= 2 &&
    entry.scores[0] != null &&
    entry.scores[1] != null
  ) {
    const [left, right] = forward
      ? [expected.scoreA, expected.scoreB]
      : [expected.scoreB, expected.scoreA];
    if (entry.scores[0] !== left || entry.scores[1] !== right) return false;
  }
  return true;
}

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

/** URL absolue d'une image VLR (`//owcdn.net/...` ou chemin relatif). */
function vlrImageUrl(src: string | null | undefined): string | null {
  if (!src) return null;
  // Placeholder VLR (pas de vrai logo) : ne rien revendiquer.
  if (src.includes('/img/vlr/tmp/')) return null;
  if (src.startsWith('//')) return `https:${src}`;
  if (src.startsWith('/')) return `${BASE_URL}${src}`;
  return src;
}

/**
 * Fiche équipe depuis une page /team/<id> VLR : nom, tag, logo, pays (code du
 * drapeau) et roster des titulaires. Null si la page n'a pas d'en-tête équipe.
 */
export function parseVlrTeamProfile(html: string): TeamProfile | null {
  const $ = cheerio.load(html);
  const name = $('.team-header-name h1').first().text().trim() || null;
  if (!name) return null;
  const acronym = $('.team-header-tag').first().text().trim() || null;
  const imageUrl = vlrImageUrl($('.team-header-logo img').first().attr('src'));
  // Le pays vit dans la classe du drapeau (`flag mod-us`) — plus fiable que le
  // libellé texte. Codes non-pays possibles (eu, un) : flagEmoji sait les rendre.
  const flagClass = $('.team-header-country .flag').first().attr('class') ?? '';
  const location = flagClass.match(/mod-(\w{2})(?:\s|$)/)?.[1]?.toUpperCase() ?? null;
  const roster = parseVlrRoster(html);
  return { name, acronym, imageUrl, location, roster: roster.length > 0 ? roster : null };
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
    // Le pseudo est dans `.name-alias` ; il peut contenir un drapeau et une
    // icône de capitaine, d'où le nettoyage. Le patronyme vit dans `.name-real`.
    const name = item.find('.team-roster-item-name-alias').text().trim();
    const realName = item.find('.team-roster-item-name-real').text().trim() || null;
    if (name) starters.push({ name, externalId, realName });
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

/** Stats de l'onglet Performance VLR d'un joueur (multikills, clutchs, éco…). */
export interface VlrPerfStats {
  multiKills: number;
  clutches: number;
  econRating: number;
  plants: number;
  defuses: number;
}

/** Une table Performance VLR → stats par pseudo normalisé. */
function parseVlrPerformanceTable(
  $: cheerio.CheerioAPI,
  table: cheerio.Cheerio<never>,
): Map<string, VlrPerfStats> {
  const out = new Map<string, VlrPerfStats>();
  table.find('tr').each((_i, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 14) return; // en-tête (th) ou ligne incomplète
    const nameNode = $(cells[0]).find('.team > div').first().clone();
    nameNode.find('.team-tag').remove();
    const name = nameNode.text().trim();
    if (!name) return;
    const val = (index: number): number => {
      // Texte direct de la cellule seulement : les tables par map ont des
      // tooltips (« Round 5… ») dont les chiffres pollueraient l'extraction.
      const sq = $(cells[index]).find('.stats-sq').first().clone();
      sq.children().remove();
      const value = Number(sq.text().trim().replace(/[^\d.-]/g, ''));
      return Number.isFinite(value) ? value : 0;
    };
    out.set(normalizeName(name), {
      multiKills: val(2) + val(3) + val(4) + val(5), // 2K+3K+4K+5K
      clutches: val(6) + val(7) + val(8) + val(9) + val(10), // 1v1..1v5
      econRating: val(11),
      plants: val(12),
      defuses: val(13),
    });
  });
  return out;
}

/**
 * Parse l'onglet Performance d'un match VLR (`?game=all&tab=performance`) : une
 * table `wf-table-inset mod-adv` par vue — la première est l'agrégat all-maps,
 * les suivantes le détail de chaque manche (même ordre que les blocs de la page
 * overview). Colonnes : [équipe][agent] 2K 3K 4K 5K 1v1..1v5 ECON PL DE.
 * Clé = pseudo normalisé (aligné sur mapVlrMatchHtml). Cellules vides
 * (`mod-egg`) = 0.
 */
export function parseVlrPerformanceViews(html: string): {
  all: Map<string, VlrPerfStats>;
  perGame: Array<Map<string, VlrPerfStats>>;
} {
  const $ = cheerio.load(html);
  // `mod-adv-stats` depuis le re-design VLR (anciennement `mod-adv`) — les
  // tables `mod-matrix` (duels) ne doivent pas matcher.
  const tables = $('table.wf-table-inset.mod-adv-stats, table.wf-table-inset.mod-adv')
    .toArray()
    .map((table) => parseVlrPerformanceTable($, $(table) as cheerio.Cheerio<never>));
  const [all, ...perGame] = tables;
  return { all: all ?? new Map(), perGame };
}

/** Agrégat all-maps de l'onglet Performance (rétro-compatibilité specs). */
export function parseVlrPerformance(html: string): Map<string, VlrPerfStats> {
  return parseVlrPerformanceViews(html).all;
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
          // Détail avancé par map (vue « Avancé » du front).
          adr: stats.adr,
          rating: stats.rating,
          kast: stats.kast,
          hsPercent: stats.hsPercent,
          firstDeaths: stats.firstDeaths,
        });
        perMapByPlayer.set(nameKey, entries);
      }
    });

  const lines: ProviderStatLine[] = [];
  for (const [nameKey, stats] of aggregate) {
    // Agrégat série intégralement vide ou nul : pas un participant (remplaçant
    // listé dans le lineup, ligne parasite d'une page live) — même filtre que
    // sources. Un joueur qui a réellement joué a des kills, des morts ou de l'ACS.
    const participated =
      (stats.kills ?? 0) > 0 ||
      (stats.deaths ?? 0) > 0 ||
      (stats.assists ?? 0) > 0 ||
      (stats.acs ?? 0) > 0;
    if (!participated) continue;
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
    // Map jamais jouée d'un BO plié (VLR l'affiche 0-0) : rien à montrer — une
    // map de Valorant réellement jouée ne peut pas finir 0-0.
    if (scores[0] === 0 && scores[1] === 0) return;
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
      (await this.findMatchPath(context.teamA, context.teamB, ['/matches/results'], {
        reference: match.beginAt ?? match.scheduledAt,
        scoreA: match.scoreA,
        scoreB: match.scoreB,
      }));
    if (!matchPath) {
      this.logger.warn(
        `VLR : match ${context.teamA.name} vs ${context.teamB.name} introuvable dans les résultats récents`,
      );
      return null;
    }
    // Match fini : on enrichit avec l'onglet Performance (multikills, clutchs,
    // eco, plants/defuses) — stats figees, une requete de plus justifiee.
    return this.fetchFromPath(matchPath, context, true);
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
    // équipe (fiable). Sinon, repli sur la recherche par nom (stricte).
    const teamId = providerTeamId ?? (await this.searchTeam(teamName, aliases))?.id;
    if (!teamId) return null;

    const page = await politeFetch(`${BASE_URL}/team/${teamId}`);
    if (!page.ok) return null;
    const starters = parseVlrRoster(await page.text());
    return starters.length > 0 ? starters : null;
  }

  /**
   * Résolution proactive nom → id VLR par la recherche. Stricte : nom exact
   * unique, sinon candidat au nom proche dont le tag d'équipe est EXACTEMENT
   * l'acronym Pandascore (vérifié en ouvrant la page candidate). Ambigu ou
   * sans confirmation → null (jamais de best guess, l'apprentissage par match
   * résolu prendra le relais).
   */
  async searchTeam(
    name: string,
    aliases: string[],
    acronym?: string | null,
  ): Promise<TeamSearchResult | null> {
    const teamRef: TeamRef = { name, aliases };
    for (const query of [name, ...aliases]) {
      const response = await politeFetch(
        `${BASE_URL}/search/?q=${encodeURIComponent(query)}&type=teams`,
      );
      if (!response.ok) continue;
      const results = parseVlrTeamSearch(await response.text());
      const exact = results.filter(
        (result) => normalizeName(result.name) === normalizeName(query),
      );
      if (exact.length === 1) return exact[0];
      if (exact.length > 1) continue; // homonymes : indécidable sur le nom seul
      if (!acronym) continue; // pas de tag pour confirmer un nom proche
      const fuzzy = results.filter((result) => teamMatches(result.name, teamRef)).slice(0, 3);
      const confirmed: TeamSearchResult[] = [];
      for (const candidate of fuzzy) {
        const profile = await this.fetchTeamProfile(candidate.id);
        if (profile?.acronym && normalizeName(profile.acronym) === normalizeName(acronym)) {
          confirmed.push(candidate);
        }
      }
      if (confirmed.length === 1) return confirmed[0];
    }
    return null;
  }

  /** Fiche équipe VLR (nom, tag, logo, pays, roster) par id connu. */
  async fetchTeamProfile(providerTeamId: string): Promise<TeamProfile | null> {
    const response = await politeFetch(`${BASE_URL}/team/${providerTeamId}`);
    if (!response.ok) {
      this.logger.warn(`VLR team ${providerTeamId} → ${response.status}`);
      return null;
    }
    return parseVlrTeamProfile(await response.text());
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
      (await this.findMatchPath(context.teamA, context.teamB, ['/matches', '/matches/results'], {
        // Match en cours : la date discrimine, pas le score (il évolue).
        reference: match.beginAt ?? match.scheduledAt,
      }));
    if (!matchPath) return null;
    return this.fetchFromPath(matchPath, context, false);
  }

  private async fetchFromPath(
    matchPath: string,
    context: MatchContext,
    includePerformance: boolean,
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
    if (includePerformance) {
      await this.mergePerformance(matchPath, lines);
    }
    return {
      lines,
      games: mapVlrGames(html),
      pageUrl: matchPath,
      teamIds: parseVlrMatchTeamIds(html, context.teamA, context.teamB),
    };
  }

  /**
   * Enrichit les lignes agrégées avec l'onglet Performance (multikills, clutchs,
   * ECON, plants/defuses) : une requête VLR de plus, best-effort (un échec
   * laisse les stats de base intactes). Rapprochement par pseudo normalisé.
   * Le détail par manche est enrichi de la même façon depuis la table de
   * chaque map (vue « Avancé » d'une map précise côté front).
   */
  private async mergePerformance(matchPath: string, lines: ProviderStatLine[]): Promise<void> {
    const response = await politeFetch(`${BASE_URL}${matchPath}/?game=all&tab=performance`);
    if (!response.ok) {
      this.logger.warn(`VLR performance ${matchPath} -> ${response.status}`);
      return;
    }
    const views = parseVlrPerformanceViews(await response.text());
    if (views.all.size === 0) return;
    for (const line of lines) {
      const key = normalizeName(line.externalName);
      const stats = views.all.get(key);
      if (stats) {
        Object.assign(line.normalized as Record<string, unknown>, {
          multiKills: stats.multiKills,
          clutches: stats.clutches,
          econRating: stats.econRating,
          plants: stats.plants,
          defuses: stats.defuses,
        });
      }
      // Table de la manche : même ordre que les blocs overview (position 1..N).
      const perMap = line.perMap as unknown as MapStatsEntry[] | null;
      for (const entry of perMap ?? []) {
        const gameStats = views.perGame[entry.position - 1]?.get(key);
        if (!gameStats) continue;
        entry.multiKills = gameStats.multiKills;
        entry.clutches = gameStats.clutches;
        entry.econRating = gameStats.econRating;
        entry.plants = gameStats.plants;
        entry.defuses = gameStats.defuses;
      }
    }
  }

  /**
   * Scanne des listes de matchs VLR et retrouve le lien par noms d'équipes
   * (alias inclus), confirmé par la date du listing et le score global quand
   * ils sont connus — sans quoi un matchup répété (NRG vs 100T joué 5 fois)
   * rattacherait la même page à tous les matchs.
   */
  private async findMatchPath(
    teamA: TeamRef & { providerIds?: unknown },
    teamB: TeamRef & { providerIds?: unknown },
    listings: string[],
    expected?: VlrMatchExpectation,
  ): Promise<string | null> {
    for (const listing of listings) {
      const pages = listing === '/matches/results' ? RESULT_PAGES_TO_SCAN : 1;
      for (let page = 1; page <= pages; page += 1) {
        const response = await politeFetch(`${BASE_URL}${listing}?page=${page}`);
        if (!response.ok) return null;
        const found = parseVlrMatchListing(await response.text()).find((entry) =>
          vlrListingEntryMatches(entry, teamA, teamB, expected),
        );
        if (found) return found.href;
      }
    }
    // Match trop ancien pour les listings récents (backfill historique) :
    // recherche dans l'historique de matchs d'une équipe dont l'id VLR est
    // connu. Réservé aux matchs vraiment vieux : un match récent introuvable
    // ci-dessus est un vrai trou de couverture.
    const reference = expected?.reference;
    if (reference && Date.now() - reference.getTime() > 3 * 24 * 3600 * 1000) {
      const candidates: Array<[TeamRef & { providerIds?: unknown }, TeamRef, boolean]> = [
        [teamA, teamB, true],
        [teamB, teamA, false],
      ];
      for (const [team, opponent, teamIsA] of candidates) {
        const vlrId = (team.providerIds as Record<string, string> | null)?.vlr;
        if (!vlrId) continue;
        const path = await this.searchTeamHistory(vlrId, opponent, {
          reference,
          ownScore: teamIsA ? expected?.scoreA : expected?.scoreB,
          oppScore: teamIsA ? expected?.scoreB : expected?.scoreA,
        });
        if (path) return path;
      }
    }
    return null;
  }

  /**
   * Parcourt l'historique de matchs d'une équipe VLR (anté-chronologique) à la
   * recherche de l'affiche attendue ; s'arrête dès qu'une page est entièrement
   * plus ancienne que la date visée.
   */
  private async searchTeamHistory(
    teamVlrId: string,
    opponent: TeamRef,
    expected: { reference: Date; ownScore?: number | null; oppScore?: number | null },
  ): Promise<string | null> {
    const HISTORY_PAGES_MAX = 8;
    for (let page = 1; page <= HISTORY_PAGES_MAX; page += 1) {
      const response = await politeFetch(
        `${BASE_URL}/team/matches/${teamVlrId}/?group=completed&page=${page}`,
      );
      if (!response.ok) return null;
      const items = parseVlrTeamMatches(await response.text());
      if (items.length === 0) return null;
      const found = pickVlrTeamHistoryMatch(items, opponent, expected);
      if (found) return found;
      const oldest = items[items.length - 1]?.date;
      if (oldest && oldest.getTime() < expected.reference.getTime() - LISTING_DATE_SLACK_MS) {
        return null;
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
