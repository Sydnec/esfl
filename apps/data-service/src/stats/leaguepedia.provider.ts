import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MapStatsEntry } from '@esfl/contracts';
import type { Match, Prisma } from '../../generated/client';
import { countryToIso2 } from '../common/country-iso';
import {
  normalizeName,
  opponentAliasCandidates,
  OpponentPair,
  teamMatches,
  TeamRef,
} from './matching';
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

const API_URL = 'https://lol.fandom.com/api.php';

/**
 * Espacement des requêtes Cargo. Authentifié (bot password), Fandom autorise un
 * débit bien plus élevé qu'en anonyme : on desserre nettement (l'ancien 35 s
 * était très conservateur). Ré-augmenter si des 429 apparaissent.
 */
const CARGO_SPACING_MS = 6_000;

/** Rôle de joueur LoL (exclut coach/manager/analyst de la table Players). */
function isLolStarterRole(role: string): boolean {
  return /top|jung|jgl|mid|bot|adc|carry|sup/i.test(role);
}

/** Ligne de la table Cargo Players (roster courant d'une équipe). */
export interface LeaguepediaRosterRow {
  ID?: string;
  /** Patronyme (`Players.Name`) : départage les homonymes chez Pandascore. */
  RealName?: string;
  Role?: string;
  IsRetired?: string;
  IsSubstitute?: string;
  /** Nom de fichier de la photo (→ Special:Filepath). */
  Image?: string;
  /** Pays en toutes lettres (« South Korea ») → ISO2 via countryToIso2. */
  Country?: string;
}

function isTruthyFlag(value?: string): boolean {
  const flag = (value ?? '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

/** Titulaires depuis les lignes Players : rôle de joueur, ni retraité, ni remplaçant. */
export function parseLeaguepediaRoster(rows: LeaguepediaRosterRow[]): StarterRef[] {
  const seen = new Set<string>();
  const starters: StarterRef[] = [];
  for (const row of rows) {
    if (isTruthyFlag(row.IsRetired) || isTruthyFlag(row.IsSubstitute)) continue;
    if (!isLolStarterRole(row.Role ?? '')) continue;
    const name = stripDisambiguation(row.ID ?? '').trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    const image = row.Image?.trim();
    starters.push({
      name,
      // Pas d'id numérique chez Leaguepedia : le pseudo canonique (champ ID de
      // la table Players) EST l'identifiant, mémorisé comme id provider.
      externalId: name,
      role: row.Role ?? null,
      realName: row.RealName?.trim() || null,
      imageUrl: image
        ? `https://lol.fandom.com/wiki/Special:Filepath/${encodeURIComponent(image)}`
        : null,
      nationality: countryToIso2(row.Country),
    });
  }
  return starters;
}

// Cache de fenêtre : la requête Cargo ramène TOUS les matchs LoL de la période
// (le filtrage par équipe est côté client), donc tous les matchs d'une même
// tranche horaire partagent le même résultat. On regroupe les références par
// buckets de 3h et on mémorise les lignes quelques minutes : un cycle live ou
// une rafale de fins de match d'un même tournoi ne paie qu'une requête au lieu
// d'une par match — c'est ce qui saturait le rate limit Fandom.
const WINDOW_BUCKET_MS = 3 * 3600 * 1000;
const WINDOW_MARGIN_MS = 12 * 3600 * 1000;
const WINDOW_CACHE_TTL_MS = 2 * 60 * 1000;

/** Ligne brute cargoquery (join ScoreboardGames + ScoreboardPlayers). */
export interface LeaguepediaRow {
  Link?: string;
  /** Rôle joué sur la game (Top|Jungle|Mid|Bot|Support) : snapshot par match. */
  Role?: string;
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
  /** Page wiki du tournoi (lien vers la page de stats originale). */
  OverviewPage?: string;
  /** Dégâts aux champions (part d'équipe → damageShare). */
  DamageToChampions?: string;
  /** Score de vision (agrégé sur les games). */
  VisionScore?: string;
  /** Or total du joueur (part d'équipe → goldShare). */
  Gold?: string;
}

/** Retire la désambiguïsation Leaguepedia : "Faker (Lee Sang-hyeok)" → "Faker". */
function stripDisambiguation(link: string): string {
  return link.replace(/\s*\(.*\)$/, '');
}

/** Paires `nom=valeur` des Set-Cookie d'une réponse (sans les attributs). */
function cookiePairs(response: Response): string[] {
  const headers = response.headers as unknown as { getSetCookie?: () => string[] };
  return (headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';')[0].trim())
    .filter(Boolean);
}

/** Fusionne des groupes de cookies en un en-tête `Cookie` (dernière valeur gagne). */
function mergeCookieHeader(...groups: string[][]): string {
  const jar = new Map<string, string>();
  for (const group of groups) {
    for (const pair of group) {
      const eq = pair.indexOf('=');
      if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
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

  // Totaux d'équipe par game (kills, dégâts, or) : base des ratios KP%,
  // damageShare et goldShare.
  const teamTotals = new Map<string, { kills: number; damage: number; gold: number }>();
  for (const row of matchRows) {
    const key = `${row.GameId ?? ''}::${row.Team ?? ''}`;
    const totals = teamTotals.get(key) ?? { kills: 0, damage: 0, gold: 0 };
    totals.kills += Number(row.Kills ?? 0);
    totals.damage += Number(row.DamageToChampions ?? 0);
    totals.gold += Number(row.Gold ?? 0);
    teamTotals.set(key, totals);
  }

  interface Aggregate {
    kills: number;
    deaths: number;
    assists: number;
    cs: number;
    minutes: number;
    wins: number;
    games: number;
    vision: number;
    kpSum: number;
    shareSum: number;
    goldShareSum: number;
    team: string | null;
    role: string | null;
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
      vision: 0,
      kpSum: 0,
      shareSum: 0,
      goldShareSum: 0,
      team: null,
      role: null,
      raw: [],
      perMap: [],
    };
    aggregate.team = aggregate.team ?? row.Team ?? null;
    // Rôle du match : dernier non-vide (un swap en cours de série = dernier état).
    aggregate.role = row.Role?.trim() || aggregate.role;
    const kills = Number(row.Kills ?? 0);
    const assists = Number(row.Assists ?? 0);
    const damage = Number(row.DamageToChampions ?? 0);
    const gold = Number(row.Gold ?? 0);
    aggregate.kills += kills;
    aggregate.deaths += Number(row.Deaths ?? 0);
    aggregate.assists += assists;
    aggregate.cs += Number(row.CS ?? 0);
    aggregate.minutes += Number(row.Gamelength ?? 0);
    aggregate.wins += row.PlayerWin === 'Yes' ? 1 : 0;
    aggregate.vision += Number(row.VisionScore ?? 0);
    aggregate.games += 1;
    // Ratios par game (moyennés ensuite) : KP% = (K+A)/kills équipe ; part de dégâts.
    const team = teamTotals.get(`${row.GameId ?? ''}::${row.Team ?? ''}`);
    aggregate.kpSum += team && team.kills > 0 ? (kills + assists) / team.kills : 0;
    aggregate.shareSum += team && team.damage > 0 ? damage / team.damage : 0;
    aggregate.goldShareSum += team && team.gold > 0 ? gold / team.gold : 0;
    aggregate.raw.push(row);
    // Détail de la game : champion + stats (pas de map en LoL), ratios
    // d'équipe inclus pour la vue « Avancé » d'une game précise.
    const gameMinutes = Number(row.Gamelength ?? 0);
    const ratio = (value: number, total: number | undefined) =>
      total && total > 0 ? Math.round((value / total) * 1000) / 1000 : null;
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
      killParticipation: ratio(kills + assists, team?.kills),
      damageShare: ratio(damage, team?.damage),
      goldShare: ratio(gold, team?.gold),
      visionScore: Number(row.VisionScore ?? 0),
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
      // Le pseudo canonique des scoreboards (Link désambiguïsé) sert d'id
      // provider : appris sur Player.providerIds.leaguepedia.
      externalId: name,
      side,
      teamName: aggregate.team ?? null,
      role: aggregate.role,
      raw: aggregate.raw as unknown as Prisma.InputJsonValue,
      normalized: (() => {
        // Une game longue gonfle mécaniquement les compteurs : les variantes
        // par minute nuancent K/D/A et vision pour le scoring.
        const perMin = (value: number) =>
          aggregate.minutes > 0 ? Math.round((value / aggregate.minutes) * 100) / 100 : null;
        return {
          kills: aggregate.kills,
          deaths: aggregate.deaths,
          assists: aggregate.assists,
          csPerMin: perMin(aggregate.cs),
          win: aggregate.wins * 2 > aggregate.games,
          killParticipation:
            aggregate.games > 0 ? Math.round((aggregate.kpSum / aggregate.games) * 1000) / 1000 : null,
          damageShare:
            aggregate.games > 0 ? Math.round((aggregate.shareSum / aggregate.games) * 1000) / 1000 : null,
          visionScore: aggregate.vision,
          goldShare:
            aggregate.games > 0 ? Math.round((aggregate.goldShareSum / aggregate.games) * 1000) / 1000 : null,
          killsPerMin: perMin(aggregate.kills),
          deathsPerMin: perMin(aggregate.deaths),
          assistsPerMin: perMin(aggregate.assists),
          visionPerMin: perMin(aggregate.vision),
          durationMinutes: aggregate.minutes > 0 ? Math.round(aggregate.minutes) : null,
        };
      })(),
      perMap: aggregate.perMap.sort((a, b) => a.position - b.position) as unknown as Prisma.InputJsonValue,
    });
  }
  return lines;
}

/**
 * URL de la page wiki du tournoi où vivent les scoreboards du match : le lien
 * « page de stats originale » affiché sur le front. Null si la fenêtre ne
 * porte pas l'OverviewPage.
 */
export function leaguepediaPageUrl(
  rows: LeaguepediaRow[],
  teamA: TeamRef,
  teamB: TeamRef,
): string | null {
  const row = rows.find((candidate) => {
    const team1 = candidate.Team1 ?? '';
    const team2 = candidate.Team2 ?? '';
    return (
      (teamMatches(team1, teamA) && teamMatches(team2, teamB)) ||
      (teamMatches(team1, teamB) && teamMatches(team2, teamA))
    );
  });
  const page = row?.OverviewPage?.trim();
  return page ? `https://lol.fandom.com/wiki/${encodeURI(page.replace(/ /g, '_'))}` : null;
}

/**
 * Nom canonique Leaguepedia de chaque équipe (celui des scoreboards / de la
 * table Players), par côté A/B — à persister comme id provider pour requêter le
 * roster sans ambiguïté.
 *
 * Cherché uniquement dans les lignes du match (les deux équipes reconnues),
 * jamais dans le reste de la fenêtre : « T1 » matche « T1.EA » par inclusion,
 * et une game de l'académie dans la fenêtre ferait apprendre le mauvais
 * canonique (l'enrichissement renommerait ensuite l'équipe). L'égalité exacte
 * l'emporte sur l'inclusion quand les deux existent.
 */
export function leaguepediaTeamNames(
  rows: LeaguepediaRow[],
  teamA: TeamRef,
  teamB: TeamRef,
): { A?: string | null; B?: string | null } {
  const matchRows = rows.filter((row) => {
    const team1 = row.Team1 ?? '';
    const team2 = row.Team2 ?? '';
    return (
      (teamMatches(team1, teamA) && teamMatches(team2, teamB)) ||
      (teamMatches(team1, teamB) && teamMatches(team2, teamA))
    );
  });
  const canonical = (team: TeamRef): string | null => {
    let fuzzy: string | null = null;
    for (const row of matchRows) {
      for (const name of [row.Team1, row.Team2]) {
        if (!name || !teamMatches(name, team)) continue;
        if (normalizeName(name) === normalizeName(team.name)) return name;
        fuzzy = fuzzy ?? name;
      }
    }
    return fuzzy;
  };
  return { A: canonical(teamA), B: canonical(teamB) };
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
    const minutes = Number(gameRows[0].Gamelength ?? 0);
    games.push({
      position: Number(gameRows[0].GameNumber ?? fallbackPosition) || fallbackPosition,
      map: null,
      // Une game LoL a une durée variable : affichée sur le front et utile pour
      // relativiser les compteurs.
      lengthSec: minutes > 0 ? Math.round(minutes * 60) : null,
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
  /**
   * bucketStart (ms) → promesse des lignes de la fenêtre + horodatage (TTL
   * court). Une promesse (et non le résultat) : avec le worker concurrent,
   * plusieurs matchs LoL du même bucket partagent la même requête en vol au
   * lieu de la dupliquer.
   */
  private readonly windowCache = new Map<
    number,
    { promise: Promise<LeaguepediaRow[] | null>; at: number }
  >();
  /** En-tête Cookie de la session Leaguepedia authentifiée (null = anonyme). */
  private sessionCookie: string | null = null;
  /** Login en cours, pour ne pas se connecter plusieurs fois en parallèle. */
  private loginInFlight: Promise<string | null> | null = null;

  constructor(private readonly config: ConfigService) {}

  /**
   * Requête MediaWiki authentifiée si des identifiants sont configurés
   * (`LEAGUEPEDIA_USERNAME`/`_BOT_PASSWORD`) : bien plus haute limite de lecture
   * qu'en anonyme. Ajoute `assert=user` pour détecter une session expirée
   * (l'API répond alors `assertuserfailed` au lieu de servir en anonyme).
   */
  private async fetchAuthed(url: URL, spacingMs: number): Promise<Response> {
    const cookie = await this.ensureSession();
    if (cookie) url.searchParams.set('assert', 'user');
    return politeFetch(url, cookie ? { headers: { Cookie: cookie } } : {}, spacingMs);
  }

  /** Cookie de session (login paresseux, mémorisé) ; null si non configuré/échec. */
  private async ensureSession(): Promise<string | null> {
    const user = this.config.get<string>('LEAGUEPEDIA_USERNAME');
    const pass = this.config.get<string>('LEAGUEPEDIA_BOT_PASSWORD');
    if (!user || !pass) return null;
    if (this.sessionCookie) return this.sessionCookie;
    if (!this.loginInFlight) {
      this.loginInFlight = this.login(user, pass).finally(() => {
        this.loginInFlight = null;
      });
    }
    return this.loginInFlight;
  }

  private invalidateSession(): void {
    this.sessionCookie = null;
  }

  /** Login MediaWiki par bot password : jeton puis action=login, cookies mémorisés. */
  private async login(user: string, pass: string): Promise<string | null> {
    try {
      const tokenUrl = new URL(API_URL);
      tokenUrl.searchParams.set('action', 'query');
      tokenUrl.searchParams.set('meta', 'tokens');
      tokenUrl.searchParams.set('type', 'login');
      tokenUrl.searchParams.set('format', 'json');
      const tokenResponse = await politeFetch(tokenUrl, {}, 1_000);
      const tokenCookies = cookiePairs(tokenResponse);
      const tokenJson = (await tokenResponse.json()) as {
        query?: { tokens?: { logintoken?: string } };
      };
      const loginToken = tokenJson.query?.tokens?.logintoken;
      if (!loginToken) {
        this.logger.warn('Leaguepedia : jeton de login indisponible');
        return null;
      }

      const body = new URLSearchParams({
        action: 'login',
        lgname: user,
        lgpassword: pass,
        lgtoken: loginToken,
        format: 'json',
      });
      const loginResponse = await politeFetch(
        API_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: mergeCookieHeader(tokenCookies),
          },
          body: body.toString(),
        },
        1_000,
      );
      const loginJson = (await loginResponse.json()) as { login?: { result?: string } };
      if (loginJson.login?.result !== 'Success') {
        this.logger.warn(`Leaguepedia : login refusé (${loginJson.login?.result ?? 'inconnu'})`);
        return null;
      }
      this.sessionCookie = mergeCookieHeader(tokenCookies, cookiePairs(loginResponse));
      this.logger.log('Leaguepedia : session authentifiée établie');
      return this.sessionCookie;
    } catch (error) {
      this.logger.warn(`Leaguepedia : login en erreur (${String(error)})`);
      return null;
    }
  }

  async fetchStats(match: Match, context: MatchContext): Promise<ProviderResult | null> {
    if (!context.teamA || !context.teamB) return null;
    const reference = match.beginAt ?? match.scheduledAt;
    if (!reference) return null;

    const rows = await this.fetchWindowRows(reference);
    if (!rows) return null;

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
      teamIds: leaguepediaTeamNames(rows, context.teamA, context.teamB),
      pageUrl: leaguepediaPageUrl(rows, context.teamA, context.teamB),
    };
  }

  /** Affiches LoL de la fenêtre dont une seule équipe est reconnue (matching manuel). */
  async suggestTeamNames(
    match: Match,
    context: MatchContext,
  ): Promise<Array<{ side: 'A' | 'B'; name: string }>> {
    if (!context.teamA || !context.teamB) return [];
    const reference = match.beginAt ?? match.scheduledAt;
    if (!reference) return [];
    const rows = await this.fetchWindowRows(reference);
    if (!rows) return [];
    const seen = new Set<string>();
    const pairs: OpponentPair[] = [];
    for (const row of rows) {
      const nameA = row.Team1 ?? '';
      const nameB = row.Team2 ?? '';
      const key = `${nameA}|${nameB}`;
      if (!nameA || !nameB || seen.has(key)) continue;
      seen.add(key);
      pairs.push({ nameA, nameB });
    }
    return opponentAliasCandidates(pairs, context.teamA, context.teamB).map((candidate) => ({
      side: candidate.team,
      name: candidate.alias,
    }));
  }

  /**
   * Lignes Cargo de la fenêtre englobant `reference`, mutualisées entre matchs.
   * Buckets de 3h : la fenêtre [bucket-12h, bucket+3h+12h] couvre ±12h autour de
   * n'importe quelle référence du bucket. Résultat mémorisé quelques minutes.
   * Null (non caché) en cas d'échec réseau/API : le retry repassera.
   */
  private async fetchWindowRows(reference: Date): Promise<LeaguepediaRow[] | null> {
    const bucketStart = Math.floor(reference.getTime() / WINDOW_BUCKET_MS) * WINDOW_BUCKET_MS;
    const now = Date.now();
    // Purge des entrées expirées (borne la taille du cache).
    for (const [key, entry] of this.windowCache) {
      if (now - entry.at >= WINDOW_CACHE_TTL_MS) this.windowCache.delete(key);
    }
    const cached = this.windowCache.get(bucketStart);
    if (cached) return cached.promise;

    // Promesse posée avant le premier await : les appels concurrents du même
    // bucket la partagent. Un échec (null/rejet) est retiré du cache pour que
    // le retry suivant refasse vraiment la requête.
    const promise = this.fetchWindowRowsRemote(bucketStart)
      .then((rows) => {
        if (rows === null) this.windowCache.delete(bucketStart);
        return rows;
      })
      .catch((error) => {
        this.windowCache.delete(bucketStart);
        this.logger.warn(`Leaguepedia fenêtre : ${String(error)}`);
        return null;
      });
    this.windowCache.set(bucketStart, { promise, at: now });
    return promise;
  }

  /** Requête Cargo réelle d'une fenêtre (pagination incluse), sans cache. */
  private async fetchWindowRowsRemote(bucketStart: number): Promise<LeaguepediaRow[] | null> {
    const fmt = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
    const from = fmt(bucketStart - WINDOW_MARGIN_MS);
    const to = fmt(bucketStart + WINDOW_BUCKET_MS + WINDOW_MARGIN_MS);

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
      'SP.Link,SP.Role,SP.Champion,SP.Kills,SP.Deaths,SP.Assists,SP.CS,SP.PlayerWin,SP.Team,SP.DamageToChampions,SP.VisionScore,SP.Gold,SG.Team1,SG.Team2,SG.Gamelength_Number=Gamelength,SG.GameId=GameId,SG.N_GameInMatch=GameNumber,SG.OverviewPage=OverviewPage',
    );
    url.searchParams.set('where', `SG.DateTime_UTC >= '${from}' AND SG.DateTime_UTC <= '${to}'`);

    // Cargo tronque à 500 lignes : pagination par offset (les journées
    // chargées dépassent 500 lignes joueur×game et faisaient disparaître
    // des joueurs du match), 3 pages maximum.
    const rows: LeaguepediaRow[] = [];
    for (let offset = 0; offset < 1500; offset += 500) {
      url.searchParams.set('offset', String(offset));
      const response = await this.fetchAuthed(url, CARGO_SPACING_MS);
      if (!response.ok) {
        this.logger.warn(`Leaguepedia → ${response.status}`);
        return null;
      }
      const payload = (await response.json()) as {
        cargoquery?: Array<{ title: LeaguepediaRow }>;
        error?: { code?: string };
      };
      if (payload.error) {
        // Session expirée : on l'invalide pour que la prochaine tentative se reconnecte.
        if (payload.error.code === 'assertuserfailed') this.invalidateSession();
        this.logger.warn(`Leaguepedia cargoquery en erreur : ${JSON.stringify(payload.error)}`);
        return null;
      }
      const page = (payload.cargoquery ?? []).map((entry) => entry.title);
      rows.push(...page);
      if (page.length < 500) break;
    }

    return rows;
  }

  /**
   * Titulaires actuels d'une équipe LoL : table Cargo `Players` (roster courant
   * via le champ Team), filtrée aux joueurs (rôle de joueur, ni retraités ni
   * remplaçants). Résout d'abord le nom canonique via TeamRedirects. Null si la
   * requête échoue ou ne rend rien → fallback Pandascore côté ingestion.
   */
  async fetchStarters(
    teamName: string,
    aliases: string[],
    providerTeamId?: string | null,
  ): Promise<StarterRef[] | null> {
    // Nom canonique appris depuis un match résolu : requête directe, sinon on
    // le résout via TeamRedirects (+ nom/alias en repli).
    let names: string[];
    if (providerTeamId) {
      names = [providerTeamId];
    } else {
      const resolved = await this.resolveTeamNames(teamName).catch(() => []);
      names = [...new Set([...resolved, teamName, ...aliases])].filter(Boolean);
    }
    if (names.length === 0) return null;
    const rows = await this.queryRoster(names);
    if (rows === null) return null;
    const starters = parseLeaguepediaRoster(rows);
    return starters.length > 0 ? starters : null;
  }

  /**
   * Patronyme et pays de joueurs précis, par pseudo canonique (l'id provider
   * Leaguepedia). Le sync des rosters ne couvre que les titulaires actuels : un
   * ancien joueur ou un académie n'y passe jamais, alors que c'est justement
   * lui qu'il faut départager face à un homonyme chez Pandascore.
   */
  async fetchPlayerIdentities(
    ids: string[],
  ): Promise<Map<string, { realName: string | null; nationality: string | null }>> {
    const out = new Map<string, { realName: string | null; nationality: string | null }>();
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const inList = chunk.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
      const url = new URL(API_URL);
      url.searchParams.set('action', 'cargoquery');
      url.searchParams.set('format', 'json');
      url.searchParams.set('limit', '100');
      url.searchParams.set('tables', 'Players');
      url.searchParams.set('fields', 'Players.ID=ID,Players.Name=RealName,Players.Country=Country');
      url.searchParams.set('where', `Players.ID IN (${inList})`);
      const response = await this.fetchAuthed(url, CARGO_SPACING_MS);
      if (!response.ok) {
        this.logger.warn(`Leaguepedia identités → ${response.status}`);
        continue;
      }
      const payload = (await response.json()) as {
        cargoquery?: Array<{ title: LeaguepediaRosterRow }>;
        error?: { code?: string };
      };
      if (payload.error) {
        if (payload.error.code === 'assertuserfailed') this.invalidateSession();
        this.logger.warn(`Leaguepedia identités en erreur : ${JSON.stringify(payload.error)}`);
        continue;
      }
      for (const entry of payload.cargoquery ?? []) {
        const id = stripDisambiguation(entry.title.ID ?? '').trim();
        if (!id) continue;
        out.set(id, {
          realName: entry.title.RealName?.trim() || null,
          nationality: countryToIso2(entry.title.Country),
        });
      }
    }
    return out;
  }

  private async queryRoster(names: string[]): Promise<LeaguepediaRosterRow[] | null> {
    const inList = names.map((name) => `'${name.replace(/'/g, "''")}'`).join(', ');
    const url = new URL(API_URL);
    url.searchParams.set('action', 'cargoquery');
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '60');
    url.searchParams.set('tables', 'Players');
    url.searchParams.set(
      'fields',
      'Players.ID=ID,Players.Name=RealName,Players.Role=Role,Players.IsRetired=IsRetired,Players.IsSubstitute=IsSubstitute,Players.Image=Image,Players.Country=Country',
    );
    url.searchParams.set('where', `Players.Team IN (${inList})`);
    const response = await this.fetchAuthed(url, CARGO_SPACING_MS);
    if (!response.ok) {
      this.logger.warn(`Leaguepedia roster → ${response.status}`);
      return null;
    }
    const payload = (await response.json()) as {
      cargoquery?: Array<{ title: LeaguepediaRosterRow }>;
      error?: { code?: string };
    };
    if (payload.error) {
      if (payload.error.code === 'assertuserfailed') this.invalidateSession();
      this.logger.warn(`Leaguepedia roster en erreur : ${JSON.stringify(payload.error)}`);
      return null;
    }
    return (payload.cargoquery ?? []).map((entry) => entry.title);
  }

  /**
   * Résolution proactive nom → nom canonique Leaguepedia (l'« id » provider).
   * Stricte : correspondance exacte de la table TeamRedirects (chaque AllName
   * est une forme officielle de l'équipe), sinon équipe au tag (Short)
   * EXACTEMENT identique dont le nom reste proche. Null si inconnu ou ambigu.
   */
  async searchTeam(
    name: string,
    aliases: string[],
    acronym?: string | null,
  ): Promise<TeamSearchResult | null> {
    for (const query of [name, ...aliases]) {
      const input = query.trim();
      if (!input) continue;
      const row = (await this.queryTeamRedirects('AllName', input))[0];
      const canonical = row?.canonical?.trim();
      if (canonical) return { id: canonical, name: canonical };
    }
    if (acronym) {
      const rows = await this.queryTeamsByShort(acronym);
      const confirmed = rows.filter(
        (row) => row.name && teamMatches(row.name, { name, aliases }),
      );
      if (confirmed.length === 1 && confirmed[0].page) {
        return { id: confirmed[0].page, name: confirmed[0].name ?? confirmed[0].page };
      }
    }
    return null;
  }

  /** Équipes de la table Cargo Teams portant exactement ce tag (Short). */
  private async queryTeamsByShort(
    acronym: string,
  ): Promise<Array<{ page?: string; name?: string }>> {
    const url = new URL(API_URL);
    url.searchParams.set('action', 'cargoquery');
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '10');
    url.searchParams.set('tables', 'Teams');
    url.searchParams.set('fields', 'Teams._pageName=page,Teams.Name=name');
    url.searchParams.set(
      'where',
      `Teams.Short="${acronym.replace(/"/g, '')}" AND Teams.IsDisbanded="0"`,
    );
    try {
      const response = await this.fetchAuthed(url, CARGO_SPACING_MS);
      if (!response.ok) return [];
      const payload = (await response.json()) as {
        cargoquery?: Array<{ title: { page?: string; name?: string } }>;
        error?: { code?: string };
      };
      if (payload.error?.code === 'assertuserfailed') this.invalidateSession();
      if (payload.error) return [];
      return (payload.cargoquery ?? []).map((entry) => entry.title);
    } catch {
      return [];
    }
  }

  /**
   * Fiche équipe Leaguepedia (table Cargo `Teams`, par page d'overview) : nom,
   * tag court, logo (via Special:Filepath) et roster courant. La localisation
   * Leaguepedia est un nom de pays/région (pas un code ISO2) : on ne la
   * revendique pas, le fallback Pandascore reste en place.
   */
  async fetchTeamProfile(providerTeamId: string): Promise<TeamProfile | null> {
    const url = new URL(API_URL);
    url.searchParams.set('action', 'cargoquery');
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '1');
    url.searchParams.set('tables', 'Teams');
    url.searchParams.set('fields', 'Teams.Name=name,Teams.Short=short,Teams.Image=image');
    url.searchParams.set('where', `Teams._pageName="${providerTeamId.replace(/"/g, '')}"`);
    const response = await this.fetchAuthed(url, CARGO_SPACING_MS);
    if (!response.ok) {
      this.logger.warn(`Leaguepedia team ${providerTeamId} → ${response.status}`);
      return null;
    }
    const payload = (await response.json()) as {
      cargoquery?: Array<{ title: { name?: string; short?: string; image?: string } }>;
      error?: { code?: string };
    };
    if (payload.error) {
      if (payload.error.code === 'assertuserfailed') this.invalidateSession();
      this.logger.warn(`Leaguepedia team en erreur : ${JSON.stringify(payload.error)}`);
      return null;
    }
    const row = payload.cargoquery?.[0]?.title;
    if (!row) return null;
    const image = row.image?.trim();
    const roster = parseLeaguepediaRoster((await this.queryRoster([providerTeamId])) ?? []);
    return {
      name: row.name?.trim() || providerTeamId,
      acronym: row.short?.trim() || null,
      imageUrl: image
        ? `https://lol.fandom.com/wiki/Special:Filepath/${encodeURIComponent(image)}`
        : null,
      roster: roster.length > 0 ? roster : null,
    };
  }

  /**
   * Résout un nom d'équipe vers ses formes Leaguepedia via la table Cargo
   * `TeamRedirects` (AllName → OtherName canonique) : renvoie le nom canonique
   * (celui qu'utilisent les scoreboards) et toutes ses variantes/renommages.
   * Coller un lien lol.fandom.com donne ainsi des alias fiables même si l'URL
   * est une redirection, un ancien nom ou une forme courte. Best-effort :
   * liste vide si la requête échoue (rate limit Fandom) — l'appelant retombe
   * alors sur le nom d'origine.
   */
  async resolveTeamNames(name: string): Promise<string[]> {
    const input = name.trim();
    if (!input) return [];
    // Le canonique est la page (`_pageName`) sur laquelle le nom est stocké :
    // chaque forme (AllName) vit sur la page d'overview de l'équipe. Vide/inconnu
    // → on garde la saisie.
    const row = (await this.queryTeamRedirects('AllName', input))[0];
    const canonical = row?.canonical?.trim() || input;
    // Toutes les autres formes rattachées à cette même page d'overview.
    const variants = await this.queryTeamRedirects('_pageName', canonical);
    // Le canonique (nom des scoreboards) + ses variantes + la saisie d'origine
    // (filet de sécurité si le canonique diffère mais que la saisie matche aussi).
    const names = new Set<string>([canonical, input]);
    for (const variant of variants) if (variant.allName) names.add(variant.allName);
    return [...names];
  }

  private async queryTeamRedirects(
    field: 'AllName' | '_pageName',
    value: string,
  ): Promise<Array<{ allName?: string; canonical?: string }>> {
    const url = new URL(API_URL);
    url.searchParams.set('action', 'cargoquery');
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '100');
    url.searchParams.set('tables', 'TeamRedirects');
    // `_pageName` = page d'overview = nom canonique (les scoreboards l'utilisent).
    url.searchParams.set('fields', 'AllName=allName,_pageName=canonical');
    // Guillemets doubles autour de la valeur (gèrent les apostrophes des noms) ;
    // on retire d'éventuels guillemets doubles pour ne pas casser le where.
    url.searchParams.set('where', `${field}="${value.replace(/"/g, '')}"`);
    try {
      const response = await this.fetchAuthed(url, 20_000);
      if (!response.ok) {
        this.logger.warn(`Leaguepedia TeamRedirects → ${response.status}`);
        return [];
      }
      const payload = (await response.json()) as {
        cargoquery?: Array<{ title: { allName?: string; canonical?: string } }>;
        error?: { code?: string };
      };
      if (payload.error?.code === 'assertuserfailed') this.invalidateSession();
      return (payload.cargoquery ?? []).map((entry) => entry.title);
    } catch {
      return [];
    }
  }
}
