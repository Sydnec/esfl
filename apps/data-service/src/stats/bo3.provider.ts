import { Injectable, Logger } from '@nestjs/common';
import type { Match, Prisma, Team } from '../../generated/client';
import { normalizeName, providerTeamMatches, toSlug } from './matching';
import { politeFetch } from './polite-fetch';
import type {
  GameStatsProvider,
  MatchContext,
  ProviderGameInfo,
  ProviderResult,
  ProviderStatLine,
  TeamProfile,
  TeamSearchResult,
} from './provider';

// API publique JSON de bo3.gg (sans clé, cf. mémoire esfl-bo3gg-api). Discipline
// 1 = Counter-Strike. Cloudflare ne challenge pas les appels API avec un UA
// navigateur, mais on reste poli : espacement 3-6 s variable sur l'hôte.
const BO3_API = 'https://api.bo3.gg/api/v1';
const CS2_DISCIPLINE = 1;
const BO3_MIN_SPACING_MS = 3_000;
const BO3_JITTER_MS = 3_000;
const MATCH_PAGE_SIZE = 50;
const MATCH_MAX_PAGES = 4;

/**
 * Durée de vie du cache mémoire. Un backfill enchaîne des centaines de matchs
 * qui retapent la MÊME fenêtre (matchs d'une même journée) et les MÊMES
 * équipes, à 3-6 s l'appel : sans cache, l'essentiel du temps part en requêtes
 * déjà faites. 10 min reste court devant la fenêtre live (3 min) pour ne pas
 * masquer longtemps un match tout juste publié.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
/** Au-delà, on repart de zéro plutôt que de garder un cache non borné. */
const CACHE_MAX_ENTRIES = 2_000;

interface Bo3TeamRef {
  id: number;
  name: string;
  /** Nom canonique en minuscules-tirets : bo3 réduit parfois `name` au seul tag. */
  slug?: string | null;
  acronym?: string | null;
  image_url?: string | null;
}

interface Bo3Match {
  id: number;
  status: string;
  start_date: string;
  team1_id: number | null;
  team2_id: number | null;
}

interface Bo3Game {
  id: number;
  number: number;
  status: string;
  map_name: string | null;
  rounds_count: number | null;
  winner_clan_name: string | null;
  winner_clan_score: number | null;
  loser_clan_name: string | null;
  loser_clan_score: number | null;
}

/**
 * Ligne de `/games/{id}/players_stats` : stats ABSOLUES d'un joueur sur UNE
 * map. C'est la source riche de bo3 (KAST compris) et elle se remplit pendant
 * la partie, contrairement à l'agrégat `players/stats_list` qui reste vide sur
 * beaucoup de matchs.
 */
interface Bo3GamePlayerStat {
  game_id: number;
  clan_name: string | null;
  kills: number | null;
  death: number | null;
  assists: number | null;
  /** Dégâts par round sur la map ; `damage` est le cumul. */
  adr: number | null;
  /** Fraction 0-1 (null tant que la map n'est pas terminée). */
  kast: number | null;
  damage: number | null;
  headshots: number | null;
  first_kills: number | null;
  first_death: number | null;
  clutches: number | null;
  /** Nombre de manches par palier : `{ "2": 3, "3": 1, ... }`. */
  multikills: Record<string, number> | null;
  player_rating: number | null;
  win: number | null;
  /** Équipe DU MATCH (≠ équipe actuelle du joueur). */
  team_clan?: { team_id?: number | null; team?: { id?: number | null } | null } | null;
  steam_profile?: {
    nickname?: string | null;
    player_id?: number | null;
    player?: {
      id?: number | null;
      nickname?: string | null;
      first_name?: string | null;
      last_name?: string | null;
      country?: { code?: string | null } | null;
    } | null;
  } | null;
}

interface Bo3List<T> {
  results?: T[];
}

/** Match bo3 résolu : son id, les ids d'équipe par côté, son statut si connu. */
interface Bo3Resolution {
  matchId: string;
  idA: number | null;
  idB: number | null;
  /** Renseigné quand la résolution vient du scan de fenêtre (évite un appel). */
  status: string | null;
}

const round1 = (value: number | null | undefined) =>
  value == null ? null : Math.round(value * 10) / 10;
const round2 = (value: number | null | undefined) =>
  value == null ? null : Math.round(value * 100) / 100;
const round3 = (value: number | null | undefined) =>
  value == null ? null : Math.round(value * 1000) / 1000;
/**
 * Borne de filtre bo3 : datetime UTC sans fuseau. Une borne en `YYYY-MM-DD`
 * serait comparée à minuit — avec des opérateurs stricts, le jour du match
 * lui-même sortait de la fenêtre.
 */
const bound = (date: Date): string => date.toISOString().slice(0, 19);

/**
 * Manches couvertes par UNE ligne de stats, dénominateur de nos moyennes.
 *
 * On déduit d'abord la valeur de la ligne elle-même (`damage / adr`), et non le
 * `rounds_count` de la map : bo3 publie parfois, sur une map fraîchement
 * terminée, un instantané partiel dont les dégâts ne couvrent qu'une partie des
 * manches. Diviser ces dégâts partiels par le total officiel écrasait l'ADR
 * (699 dégâts sur 6 manches réelles donnaient 41 au lieu de 116). Sur une map
 * complète les deux coïncident, ce repli ne change donc rien aux stats finales.
 */
function roundsOf(row: Bo3GamePlayerStat, roundsByGameId: Map<number, number>): number {
  if (row.adr && row.damage) return Math.max(1, Math.round(row.damage / row.adr));
  const known = roundsByGameId.get(row.game_id);
  return known && known > 0 ? known : 0;
}

/** Manches multi-kills : bo3 compte par palier (2K, 3K…), on veut le total. */
function multiKillsOf(row: Bo3GamePlayerStat): number {
  return Object.values(row.multikills ?? {}).reduce((sum, count) => sum + (count || 0), 0);
}

/** Cumul d'un joueur sur toutes les maps de la rencontre. */
interface PlayerAccumulator {
  externalId: string | null;
  name: string;
  realName: string | null;
  nationality: string | null;
  teamId: number;
  rounds: number;
  kills: number;
  deaths: number;
  assists: number;
  firstKills: number;
  firstDeaths: number;
  multiKills: number;
  clutches: number;
  headshots: number;
  damage: number;
  /** Manches couvertes par un KAST connu, et sa somme pondérée. */
  kastRounds: number;
  kastWeighted: number;
  /** Idem pour le rating : manches où il est publié, et sa somme pondérée. */
  ratingRounds: number;
  ratingWeighted: number;
  perMap: Prisma.JsonArray;
  raw: Bo3GamePlayerStat[];
}

/**
 * Stats par map bo3 → une ProviderStatLine par joueur, cumulée sur la
 * rencontre. Pur, testable.
 *
 * Les totaux (kills, clutchs…) s'additionnent ; l'ADR se recalcule sur les
 * dégâts et les manches cumulés (une moyenne de moyennes fausserait un BO3 aux
 * maps de longueurs différentes) et le KAST se pondère par les manches où il
 * est connu. Côté A/B résolu via l'id d'équipe bo3 DU MATCH (`team_clan`), pas
 * l'équipe actuelle du joueur.
 */
export function mapBo3GameStats(
  rows: Bo3GamePlayerStat[],
  gamesById: Map<number, Bo3Game>,
  sideByTeamId: Map<number, 'A' | 'B'>,
  nameByTeamId: Map<number, string>,
): ProviderStatLine[] {
  const roundsByGameId = new Map(
    [...gamesById.values()].map((game) => [game.id, game.rounds_count ?? 0] as const),
  );
  const byPlayer = new Map<string, PlayerAccumulator>();

  for (const row of rows) {
    const rounds = roundsOf(row, roundsByGameId);
    if (rounds <= 0) continue; // remplaçant listé, aucune manche jouée
    const profile = row.steam_profile?.player;
    const externalId = profile?.id ?? row.steam_profile?.player_id ?? null;
    // Pseudo canonique du joueur pro ; `steam_profile.nickname` est le pseudo
    // Steam, souvent différent (« flawless » vs « flaw »).
    const name = profile?.nickname ?? row.steam_profile?.nickname ?? '';
    const key = externalId != null ? `id:${externalId}` : `name:${normalizeName(name)}`;
    if (!name) continue;

    let acc = byPlayer.get(key);
    if (!acc) {
      acc = {
        externalId: externalId != null ? String(externalId) : null,
        name,
        realName: [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || null,
        nationality: profile?.country?.code ?? null,
        teamId: row.team_clan?.team_id ?? row.team_clan?.team?.id ?? -1,
        rounds: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
        firstKills: 0,
        firstDeaths: 0,
        multiKills: 0,
        clutches: 0,
        headshots: 0,
        damage: 0,
        kastRounds: 0,
        kastWeighted: 0,
        ratingRounds: 0,
        ratingWeighted: 0,
        perMap: [],
        raw: [],
      };
      byPlayer.set(key, acc);
    }

    // L'équipe peut manquer sur une ligne et être présente sur la suivante :
    // sans cette reprise, une première map incomplète condamnait le joueur à
    // rester sans côté pour toute la rencontre.
    if (acc.teamId < 0) {
      acc.teamId = row.team_clan?.team_id ?? row.team_clan?.team?.id ?? -1;
    }
    acc.rounds += rounds;
    acc.kills += row.kills ?? 0;
    acc.deaths += row.death ?? 0;
    acc.assists += row.assists ?? 0;
    acc.firstKills += row.first_kills ?? 0;
    acc.firstDeaths += row.first_death ?? 0;
    acc.multiKills += multiKillsOf(row);
    acc.clutches += row.clutches ?? 0;
    acc.headshots += row.headshots ?? 0;
    acc.damage += row.damage ?? (row.adr ?? 0) * rounds;
    // Rating et KAST suivent la même règle : une map sans valeur ne compte pas
    // au dénominateur. Imputer 0 tirerait la moyenne vers le bas alors que la
    // donnée est seulement absente (map en cours, parsing en retard).
    if (row.player_rating != null) {
      acc.ratingRounds += rounds;
      acc.ratingWeighted += row.player_rating * rounds;
    }
    if (row.kast != null) {
      acc.kastRounds += rounds;
      acc.kastWeighted += row.kast * rounds;
    }
    acc.raw.push(row);
    const game = gamesById.get(row.game_id);
    acc.perMap.push({
      position: game?.number ?? 0,
      map: game?.map_name ?? null,
      rounds,
      agent: null,
      agentImage: null,
      kills: row.kills ?? null,
      deaths: row.death ?? null,
      assists: row.assists ?? null,
      adr: round2(row.adr),
      kast: row.kast != null ? round1(row.kast * 100) : null,
      rating: row.player_rating != null ? round3(row.player_rating) : null,
      headshots: row.headshots ?? null,
      firstKills: row.first_kills ?? null,
      firstDeaths: row.first_death ?? null,
      multiKills: multiKillsOf(row),
      clutches: row.clutches ?? null,
      win: row.win == null ? null : row.win === 1,
    });
  }

  return [...byPlayer.values()].map((acc) => ({
    externalName: acc.name,
    externalId: acc.externalId,
    side: sideByTeamId.get(acc.teamId) ?? null,
    teamName: nameByTeamId.get(acc.teamId) ?? null,
    realName: acc.realName,
    nationality: acc.nationality,
    role: null,
    raw: acc.raw as unknown as Prisma.InputJsonValue,
    perMap: acc.perMap.sort(
      (a, b) => (a as { position: number }).position - (b as { position: number }).position,
    ),
    normalized: {
      kills: acc.kills,
      deaths: acc.deaths,
      assists: acc.assists,
      firstKills: acc.firstKills,
      firstDeaths: acc.firstDeaths,
      multiKills: acc.multiKills,
      clutches: acc.clutches,
      headshots: acc.headshots,
      adr: round2(acc.damage / acc.rounds),
      // Fraction bo3 ramenée en pourcentage, comme le KAST Valorant.
      kast: acc.kastRounds > 0 ? round1((acc.kastWeighted / acc.kastRounds) * 100) : null,
      rating: acc.ratingRounds > 0 ? round3(acc.ratingWeighted / acc.ratingRounds) : null,
      // bo3 n'expose pas les plants/defuses par joueur.
      plants: null,
      defuses: null,
    },
  }));
}

/**
 * Manches bo3 → ProviderGameInfo, scores résolus PAR CÔTÉ.
 *
 * bo3 nomme les camps d'une manche par leur `clan_name`, qui n'est pas notre
 * nom Pandascore : laisser l'ingestion les rapprocher par nom échouait souvent
 * et vidait `scoreA`/`scoreB`, donc le total de manches du scoring — un KPR
 * calculé sur une seule manche au lieu de quarante. On s'appuie donc sur
 * `sideByClan`, construit depuis les lignes de stats où chaque joueur porte à
 * la fois son `clan_name` et l'id d'équipe bo3 qui donne le côté.
 */
export function mapBo3Games(
  games: Bo3Game[],
  sideByClan: Map<string, 'A' | 'B'>,
): ProviderGameInfo[] {
  const cote = (clan: string | null | undefined) =>
    clan ? (sideByClan.get(normalizeName(clan)) ?? null) : null;
  return (
    games
      // `rounds_count` reste nul tant que la manche n'a pas produit de round :
      // s'en tenir à lui écartait la manche EN COURS, donc le nom de la map en
      // train de se jouer. Le statut discrimine mieux que la présence d'une map,
      // celle d'une manche seulement programmée étant parfois déjà annoncée.
      .filter((game) => (game.rounds_count ?? 0) > 0 || game.status === 'current')
      .map((game) => {
        const scores: { scoreA: number | null; scoreB: number | null } = {
          scoreA: null,
          scoreB: null,
        };
        for (const camp of [
          { cote: cote(game.winner_clan_name), score: game.winner_clan_score ?? null },
          { cote: cote(game.loser_clan_name), score: game.loser_clan_score ?? null },
        ]) {
          if (camp.cote === 'A') scores.scoreA = camp.score;
          else if (camp.cote === 'B') scores.scoreB = camp.score;
        }
        return { position: game.number, map: game.map_name, ...scores };
      })
  );
}

/**
 * Provider stats CS2 via bo3.gg (remplace Grid). bo3 fournit ADR, rating,
 * clutchs, FK/FD et le vrai nom + pays des joueurs — bien au-delà de Grid.
 *
 * Résolution du match par IDENTITÉ D'ÉQUIPE : on résout d'abord nos deux
 * équipes en ids bo3 (recherche stricte par nom, mémorisée sur
 * `providerIds.bo3`), puis on trouve le match de la fenêtre dont la paire
 * `team1_id/team2_id` correspond. L'embed team1/team2 des matchs bo3 étant
 * inconstant, on ne s'y fie pas.
 */
@Injectable()
export class Bo3StatsProvider implements GameStatsProvider {
  readonly source = 'bo3';
  readonly gameId = 'cs2' as const;
  private readonly logger = new Logger(Bo3StatsProvider.name);
  /** La PROMESSE est mémorisée, pas sa valeur : cf. `cached`. */
  private readonly cache = new Map<string, { at: number; reponse: Promise<unknown> }>();

  /**
   * Appel brut, en distinguant deux situations que `null` seul confondait :
   * la source a répondu et ne connaît pas (`{ ok: true, data: null }`), ou la
   * requête a échoué (`{ ok: false }`). Sans cette distinction, une panne
   * passagère se mémorisait comme un vide légitime.
   */
  private async recuperer<T>(path: string): Promise<{ ok: true; data: T | null } | { ok: false }> {
    const spacing = BO3_MIN_SPACING_MS + Math.floor(Math.random() * BO3_JITTER_MS);
    try {
      const response = await politeFetch(`${BO3_API}${path}`, {}, spacing);
      if (!response.ok) {
        this.logger.warn(`bo3 ${path} → ${response.status}`);
        return { ok: false };
      }
      return { ok: true, data: (await response.json()) as T };
    } catch (error) {
      this.logger.warn(`bo3 ${path} : ${String(error)}`);
      return { ok: false };
    }
  }

  /**
   * Mémoïse un appel dont la réponse est stable sur quelques minutes (liste de
   * matchs d'une fenêtre, fiche équipe).
   *
   * Deux propriétés, chacune corrigeant un défaut opposé du cache précédent.
   *
   * 1. La PROMESSE est posée avant le premier await, donc les appels
   *    concurrents du même chemin la partagent. Avec cinq workers sur la même
   *    journée, l'ancienne version lançait cinq requêtes identiques — le
   *    gaspillage que le cache devait justement supprimer.
   * 2. Un ÉCHEC n'est jamais mémorisé : l'entrée est retirée pour que l'appel
   *    suivant retente. Auparavant, un seul 429 condamnait toute une fenêtre
   *    pendant dix minutes, et tous ses matchs échouaient sans requête.
   */
  private cached<T>(path: string): Promise<T | null> {
    const hit = this.cache.get(path);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.reponse as Promise<T | null>;

    const reponse = this.recuperer<T>(path).then((resultat) => {
      if (!resultat.ok) {
        this.cache.delete(path);
        return null;
      }
      return resultat.data;
    });
    if (this.cache.size >= CACHE_MAX_ENTRIES) this.cache.clear();
    this.cache.set(path, { at: Date.now(), reponse });
    return reponse;
  }

  /** Appel non mémoïsé : un échec y est indiscernable d'une absence. */
  private async get<T>(path: string): Promise<T | null> {
    const resultat = await this.recuperer<T>(path);
    return resultat.ok ? resultat.data : null;
  }

  async fetchStats(match: Match, context: MatchContext): Promise<ProviderResult | null> {
    return this.buildResult(match, context, { silent: false, requireFinished: true });
  }

  /** Live : mêmes ressources sans exiger le statut « finished ». */
  async fetchLiveStats(match: Match, context: MatchContext): Promise<ProviderResult | null> {
    return this.buildResult(match, context, { silent: true, requireFinished: false });
  }

  private async buildResult(
    match: Match,
    context: MatchContext,
    { silent, requireFinished }: { silent: boolean; requireFinished: boolean },
  ): Promise<ProviderResult | null> {
    if (!context.teamA || !context.teamB) return null;
    const reference = match.beginAt ?? match.scheduledAt;
    if (!reference) return null;

    const resolved = await this.resolveMatch(
      reference,
      context.teamA,
      context.teamB,
      match.statsPageUrl,
    );
    if (!resolved) {
      if (!silent) this.logger.warn(`bo3 : match ${match.name} introuvable`);
      return null;
    }
    const { matchId, idA, idB } = resolved;

    if (requireFinished) {
      // Statut déjà connu quand la résolution vient du scan de fenêtre : on
      // n'interroge bo3 que sur le chemin « match mémorisé ».
      const status = resolved.status ?? (await this.getMatch(matchId))?.status;
      // Statut indéterminé : on s'abstient. Poursuivre figerait comme
      // définitives les stats d'un match peut-être encore en cours — ce que ce
      // garde existe précisément pour empêcher. Le retry repassera.
      if (status !== 'finished') {
        if (!silent && !status) {
          this.logger.warn(`bo3 : statut de ${match.name} indéterminé, ingestion différée`);
        }
        return null;
      }
    }

    const gamesList = await this.get<Bo3List<Bo3Game>>(
      `/games?page%5Blimit%5D=10&filter%5Bgames.match_id%5D%5Beq%5D=${matchId}`,
    );
    const games = gamesList?.results ?? [];
    // Une map jamais commencée n'a pas de stats : inutile de la solliciter.
    const played = games.filter((game) => game.status !== 'upcoming');
    const gamesById = new Map(played.map((game) => [game.id, game]));

    const rows: Bo3GamePlayerStat[] = [];
    for (const game of played) {
      const stats = await this.get<Bo3GamePlayerStat[]>(`/games/${game.id}/players_stats`);
      if (stats?.length) rows.push(...stats);
    }

    const sideByTeamId = new Map<number, 'A' | 'B'>();
    const nameByTeamId = new Map<number, string>();
    if (idA != null) {
      sideByTeamId.set(idA, 'A');
      nameByTeamId.set(idA, context.teamA.name);
    }
    if (idB != null) {
      sideByTeamId.set(idB, 'B');
      nameByTeamId.set(idB, context.teamB.name);
    }
    const lines = mapBo3GameStats(rows, gamesById, sideByTeamId, nameByTeamId);
    if (lines.length === 0) {
      if (!silent) this.logger.warn(`bo3 : aucune ligne de stats pour ${match.name}`);
      return null;
    }

    // Nom de clan → côté, appris depuis les lignes de stats : c'est ce qui
    // permet de rattacher les scores de manche sans rapprochement par nom.
    const sideByClan = new Map<string, 'A' | 'B'>();
    for (const row of rows) {
      const teamId = row.team_clan?.team_id ?? row.team_clan?.team?.id;
      const side = teamId != null ? sideByTeamId.get(teamId) : undefined;
      if (side && row.clan_name) sideByClan.set(normalizeName(row.clan_name), side);
    }

    return {
      lines,
      games: mapBo3Games(games, sideByClan),
      pageUrl: matchId,
      teamIds: { A: idA != null ? String(idA) : null, B: idB != null ? String(idB) : null },
    };
  }

  /**
   * Résout le match bo3 + les ids d'équipe bo3 par côté. Stratégie :
   * 1. Ids mémorisés (`providerIds.bo3`) ou nom exact → résolution directe.
   * 2. Si une seule équipe est résolue, corrélation adverse : on cherche ses
   *    matchs de la fenêtre, et on rapproche (flou) le nom de l'adversaire bo3
   *    de notre autre équipe — dont l'id est alors appris.
   * L'embed team1/team2 des matchs bo3 étant inconstant, on résout les noms
   * d'équipe adverses via l'endpoint `/teams`.
   */
  private async resolveMatch(
    reference: Date,
    teamA: Team,
    teamB: Team,
    cachedMatchId: string | null,
  ): Promise<Bo3Resolution | null> {
    let idA = await this.resolveTeamId(teamA);
    let idB = await this.resolveTeamId(teamB);

    if (cachedMatchId) {
      // Match déjà connu : combler les ids manquants depuis ses équipes.
      if (idA == null || idB == null) {
        const m = await this.getMatch(cachedMatchId);
        const ids = [m?.team1_id, m?.team2_id].filter((x): x is number => !!x);
        [idA, idB] = await this.assignSides(ids, teamA, idA, teamB, idB);
      }
      return { matchId: cachedMatchId, idA, idB, status: null };
    }

    if (idA == null && idB == null) return null; // aucune équipe résolue

    const gt = bound(new Date(reference.getTime() - 12 * 3600 * 1000));
    const lt = bound(new Date(reference.getTime() + 12 * 3600 * 1000));
    const anchor = (idA ?? idB) as number;
    for (let page = 0; page < MATCH_MAX_PAGES; page += 1) {
      // Tous statuts (un match live est « current », pas « finished ») : le
      // gate requireFinished en aval décide s'il faut attendre la fin.
      const path =
        `/matches?page%5Blimit%5D=${MATCH_PAGE_SIZE}&page%5Boffset%5D=${page * MATCH_PAGE_SIZE}` +
        `&sort=-start_date&filter%5Bmatches.discipline_id%5D%5Beq%5D=${CS2_DISCIPLINE}` +
        `&filter%5Bmatches.start_date%5D%5Bgt%5D=${gt}&filter%5Bmatches.start_date%5D%5Blt%5D=${lt}`;
      const list = await this.cached<Bo3List<Bo3Match>>(path);
      const results = list?.results ?? [];
      for (const m of results) {
        if (!m.team1_id || !m.team2_id) continue;
        const ids = [m.team1_id, m.team2_id];
        if (idA != null && idB != null) {
          if (ids.includes(idA) && ids.includes(idB)) {
            return { matchId: String(m.id), idA, idB, status: m.status };
          }
          continue;
        }
        // Une seule équipe connue : l'ancre doit être présente, l'autre id est
        // l'adversaire — on vérifie son nom bo3 contre notre équipe non résolue.
        if (!ids.includes(anchor)) continue;
        const otherId = ids[0] === anchor ? ids[1] : ids[0];
        const otherRef = await this.teamRefById(otherId);
        const otherTeam = idA != null ? teamB : teamA;
        if (otherRef && providerTeamMatches(otherRef, otherTeam)) {
          return idA != null
            ? { matchId: String(m.id), idA, idB: otherId, status: m.status }
            : { matchId: String(m.id), idA: otherId, idB, status: m.status };
        }
      }
      if (results.length < MATCH_PAGE_SIZE) break;
    }
    return null;
  }

  /** Assigne (team1_id, team2_id) aux côtés A/B par nom, en comblant les ids manquants. */
  private async assignSides(
    ids: number[],
    teamA: Team,
    idA: number | null,
    teamB: Team,
    idB: number | null,
  ): Promise<[number | null, number | null]> {
    for (const id of ids) {
      if (id === idA || id === idB) continue;
      const ref = await this.teamRefById(id);
      if (!ref) continue;
      if (idA == null && providerTeamMatches(ref, teamA)) idA = id;
      else if (idB == null && providerTeamMatches(ref, teamB)) idB = id;
    }
    return [idA, idB];
  }

  /** Id d'équipe bo3 : mémorisé sur `providerIds.bo3`, sinon résolu par nom (strict). */
  private async resolveTeamId(team: Team): Promise<number | null> {
    const known = (team.providerIds as Record<string, string> | null)?.bo3;
    if (known) return Number(known);
    const found = await this.searchTeam(team.name, team.aliases ?? [], team.acronym ?? null);
    return found ? Number(found.id) : null;
  }

  private async getMatch(matchId: string): Promise<Bo3Match | null> {
    const info = await this.get<Bo3List<Bo3Match>>(
      `/matches?page%5Blimit%5D=1&filter%5Bmatches.id%5D%5Beq%5D=${matchId}`,
    );
    return info?.results?.[0] ?? null;
  }

  private async teamRefById(teamId: number): Promise<Bo3TeamRef | null> {
    const path = `/teams?page%5Blimit%5D=1&filter%5Bteams.id%5D%5Beq%5D=${teamId}`;
    const list = await this.cached<Bo3List<Bo3TeamRef>>(path);
    return list?.results?.[0] ?? null;
  }

  /**
   * Résolution proactive nom → id d'équipe bo3, stricte. Dans l'ordre :
   * 1. slug exact déduit de notre nom (« Esport Academy Copenhagen » →
   *    `esport-academy-copenhagen`) — bo3 garde le nom complet dans le slug
   *    même quand il affiche le seul tag ;
   * 2. nom exactement identique parmi les résultats de `[name][like]` ;
   * 3. tag EXACT parmi ces mêmes résultats, puis alias exact.
   * Null si introuvable ou ambigu — jamais de best guess.
   */
  async searchTeam(
    name: string,
    aliases: string[],
    acronym?: string | null,
  ): Promise<TeamSearchResult | null> {
    const bySlug = await this.teamBySlug(name);
    if (bySlug) return { id: String(bySlug.id), name: bySlug.name };

    const path =
      `/teams?page%5Blimit%5D=20&filter%5Bteams.discipline_id%5D%5Beq%5D=${CS2_DISCIPLINE}` +
      `&filter%5Bteams.name%5D%5Blike%5D=${encodeURIComponent(name)}`;
    const list = await this.cached<Bo3List<Bo3TeamRef>>(path);
    const results = list?.results ?? [];
    const wanted = normalizeName(name);
    const exact = results.filter((t) => normalizeName(t.name) === wanted);
    if (exact.length === 1) return { id: String(exact[0].id), name: exact[0].name };
    if (acronym) {
      const tag = normalizeName(acronym);
      const byTag = results.filter((t) => t.acronym && normalizeName(t.acronym) === tag);
      if (byTag.length === 1) return { id: String(byTag[0].id), name: byTag[0].name };
    }
    const aliasSet = new Set(aliases.map(normalizeName));
    const byAlias = results.filter((t) => aliasSet.has(normalizeName(t.name)));
    if (byAlias.length === 1) return { id: String(byAlias[0].id), name: byAlias[0].name };
    return null;
  }

  /** Équipe bo3 dont le slug correspond exactement à un nom donné. */
  private async teamBySlug(name: string): Promise<Bo3TeamRef | null> {
    const slug = toSlug(name);
    if (!slug) return null;
    const path = `/teams?page%5Blimit%5D=2&filter%5Bteams.slug%5D%5Beq%5D=${encodeURIComponent(slug)}`;
    const list = await this.cached<Bo3List<Bo3TeamRef>>(path);
    const results = list?.results ?? [];
    return results.length === 1 ? results[0] : null;
  }

  /** Fiche équipe bo3 (nom, tag, logo) par id connu — enrichissement CS2 (impossible avec Grid). */
  /**
   * Les liens d'équipe bo3 sont en slug (`bo3.gg/teams/3dmax`), pas en id :
   * une saisie admin copiée depuis le site ne contient donc jamais le nombre
   * attendu par l'API. On traduit via le filtre slug.
   */
  async resolveTeamIdFromSlug(saisie: string): Promise<string | null> {
    const slug = (saisie.match(/\/teams?\/([^/?#]+)/)?.[1] ?? saisie).trim().toLowerCase();
    if (!slug || /^\d+$/.test(slug)) return null;
    const list = await this.get<Bo3List<Bo3TeamRef>>(
      `/teams?page%5Blimit%5D=1&filter%5Bteams.slug%5D%5Beq%5D=${encodeURIComponent(slug)}`,
    );
    const id = list?.results?.[0]?.id;
    return id == null ? null : String(id);
  }

  async fetchTeamProfile(providerTeamId: string): Promise<TeamProfile | null> {
    const list = await this.get<Bo3List<Bo3TeamRef>>(
      `/teams?page%5Blimit%5D=1&filter%5Bteams.id%5D%5Beq%5D=${providerTeamId}`,
    );
    const t = list?.results?.[0];
    if (!t) return null;
    return {
      name: t.name,
      acronym: t.acronym ?? null,
      imageUrl: t.image_url ?? null,
      // country_id numérique chez bo3 : pas d'ISO2 fiable, fallback Pandascore.
      location: null,
      roster: null,
    };
  }
}
