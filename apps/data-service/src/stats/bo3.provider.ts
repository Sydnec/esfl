import { Injectable, Logger } from '@nestjs/common';
import type { Match, Prisma, Team } from '../../generated/client';
import { normalizeName, teamMatches } from './matching';
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
  map_name: string | null;
  rounds_count: number | null;
  winner_clan_name: string | null;
  winner_clan_score: number | null;
  loser_clan_name: string | null;
  loser_clan_score: number | null;
}

interface Bo3PlayerStat {
  player_id: number;
  rounds_count: number;
  avg_kills: number;
  avg_death: number;
  avg_assists: number;
  avg_damage: number;
  avg_player_rating: number;
  avg_first_kills: number;
  avg_first_death: number;
  avg_multikills: number;
  clutches_vs_1: number;
  clutches_vs_2: number;
  clutches_vs_3: number;
  clutches_vs_4: number;
  clutches_vs_5: number;
  player: {
    id: number;
    nickname: string;
    first_name: string | null;
    last_name: string | null;
    team_id: number | null;
    country?: { code?: string | null } | null;
  };
}

interface Bo3List<T> {
  results?: T[];
}

const rnd = (value: number) => Math.round(value);
/**
 * Borne de filtre bo3 : datetime UTC sans fuseau. Une borne en `YYYY-MM-DD`
 * serait comparée à minuit — avec des opérateurs stricts, le jour du match
 * lui-même sortait de la fenêtre.
 */
const bound = (date: Date): string => date.toISOString().slice(0, 19);

/**
 * Lignes de stats bo3 → ProviderStatLine (une par joueur). Pur, testable.
 * bo3 donne des moyennes PAR ROUND (`avg_*`) : ×`rounds_count` pour retrouver
 * les totaux attendus par `normalized`. Côté A/B résolu via l'id d'équipe bo3
 * du joueur (`player.team_id`) mappé aux côtés du match.
 */
export function mapBo3Stats(
  rows: Bo3PlayerStat[],
  sideByTeamId: Map<number, 'A' | 'B'>,
  nameByTeamId: Map<number, string>,
): ProviderStatLine[] {
  const lines: ProviderStatLine[] = [];
  for (const row of rows) {
    const rounds = row.rounds_count || 0;
    if (rounds <= 0) continue; // remplaçant listé, 0 round joué
    const teamId = row.player.team_id ?? -1;
    const clutches =
      (row.clutches_vs_1 ?? 0) +
      (row.clutches_vs_2 ?? 0) +
      (row.clutches_vs_3 ?? 0) +
      (row.clutches_vs_4 ?? 0) +
      (row.clutches_vs_5 ?? 0);
    const realName = [row.player.first_name, row.player.last_name].filter(Boolean).join(' ') || null;
    lines.push({
      externalName: row.player.nickname,
      externalId: String(row.player_id),
      side: sideByTeamId.get(teamId) ?? null,
      teamName: nameByTeamId.get(teamId) ?? null,
      realName,
      nationality: row.player.country?.code ?? null,
      role: null,
      raw: row as unknown as Prisma.InputJsonValue,
      normalized: {
        kills: rnd(row.avg_kills * rounds),
        deaths: rnd(row.avg_death * rounds),
        assists: rnd(row.avg_assists * rounds),
        firstKills: rnd(row.avg_first_kills * rounds),
        firstDeaths: rnd(row.avg_first_death * rounds),
        multiKills: rnd(row.avg_multikills * rounds),
        // Enfin disponibles côté CS2 (Grid ne les fournissait pas).
        adr: Math.round(row.avg_damage * 100) / 100,
        rating: Math.round(row.avg_player_rating * 1000) / 1000,
        clutches,
        // bo3 n'expose pas les plants/defuses par joueur.
        plants: null,
        defuses: null,
      },
    });
  }
  return lines;
}

/** Manches bo3 → ProviderGameInfo. Scores par nom de clan : l'ingestion résout les côtés. */
export function mapBo3Games(games: Bo3Game[]): ProviderGameInfo[] {
  return games
    .filter((game) => (game.rounds_count ?? 0) > 0)
    .map((game) => ({
      position: game.number,
      map: game.map_name,
      teams: [
        { name: game.winner_clan_name ?? '', score: game.winner_clan_score ?? null },
        { name: game.loser_clan_name ?? '', score: game.loser_clan_score ?? null },
      ],
    }));
}

/** Notre équipe vue du rapprochement : nom Pandascore, tag et alias appris. */
interface LocalTeamRef {
  name: string;
  acronym?: string | null;
  aliases?: string[];
}

/** Slug bo3 (« esport-academy-copenhagen ») ramené à un nom lisible. */
function fromSlug(slug: string): string {
  return slug.replace(/-/g, ' ');
}

/** Nom → slug bo3 : minuscules, séparateurs en tirets, ponctuation retirée. */
export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Rapproche une équipe bo3 de la nôtre. Le `name` bo3 se réduit parfois au seul
 * tag (« EAC » pour Esport Academy Copenhagen) : on retente alors sur le slug,
 * qui garde le nom complet, puis sur l'égalité des tags. Sans ces replis, la
 * corrélation adverse rate les équipes que bo3 abrège.
 */
export function bo3TeamMatches(ref: Bo3TeamRef, team: LocalTeamRef): boolean {
  const local = { name: team.name, aliases: team.aliases ?? [] };
  if (teamMatches(ref.name, local)) return true;
  if (ref.slug && teamMatches(fromSlug(ref.slug), local)) return true;
  const tag = team.acronym ? normalizeName(team.acronym) : '';
  if (!tag) return false;
  return normalizeName(ref.name) === tag || normalizeName(ref.acronym ?? '') === tag;
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
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  /**
   * Mémoïse un appel dont la réponse est stable sur quelques minutes (liste de
   * matchs d'une fenêtre, fiche équipe). Le résultat `null` est caché aussi :
   * une équipe introuvable le reste, la re-chercher à chaque match du backfill
   * coûterait autant qu'un vrai appel.
   */
  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
    const value = await load();
    if (this.cache.size >= CACHE_MAX_ENTRIES) this.cache.clear();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  private async get<T>(path: string): Promise<T | null> {
    const spacing = BO3_MIN_SPACING_MS + Math.floor(Math.random() * BO3_JITTER_MS);
    try {
      const response = await politeFetch(`${BO3_API}${path}`, {}, spacing);
      if (!response.ok) {
        this.logger.warn(`bo3 ${path} → ${response.status}`);
        return null;
      }
      return (await response.json()) as T;
    } catch (error) {
      this.logger.warn(`bo3 ${path} : ${String(error)}`);
      return null;
    }
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
      const info = await this.getMatch(matchId);
      if (info?.status && info.status !== 'finished') return null;
    }

    const stats = await this.get<Bo3List<Bo3PlayerStat>>(
      `/players/stats_list?page%5Blimit%5D=20&filter%5Bmatch_id%5D%5Beq%5D=${matchId}`,
    );
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
    const lines = mapBo3Stats(stats?.results ?? [], sideByTeamId, nameByTeamId);
    if (lines.length === 0) {
      if (!silent) this.logger.warn(`bo3 : aucune ligne de stats pour ${match.name}`);
      return null;
    }

    const gamesList = await this.get<Bo3List<Bo3Game>>(
      `/games?page%5Blimit%5D=10&filter%5Bgames.match_id%5D%5Beq%5D=${matchId}`,
    );
    return {
      lines,
      games: mapBo3Games(gamesList?.results ?? []),
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
  ): Promise<{ matchId: string; idA: number | null; idB: number | null } | null> {
    let idA = await this.resolveTeamId(teamA);
    let idB = await this.resolveTeamId(teamB);

    if (cachedMatchId) {
      // Match déjà connu : combler les ids manquants depuis ses équipes.
      if (idA == null || idB == null) {
        const m = await this.getMatch(cachedMatchId);
        const ids = [m?.team1_id, m?.team2_id].filter((x): x is number => !!x);
        [idA, idB] = await this.assignSides(ids, teamA, idA, teamB, idB);
      }
      return { matchId: cachedMatchId, idA, idB };
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
      const list = await this.cached(path, () => this.get<Bo3List<Bo3Match>>(path));
      const results = list?.results ?? [];
      for (const m of results) {
        if (!m.team1_id || !m.team2_id) continue;
        const ids = [m.team1_id, m.team2_id];
        if (idA != null && idB != null) {
          if (ids.includes(idA) && ids.includes(idB)) {
            return { matchId: String(m.id), idA, idB };
          }
          continue;
        }
        // Une seule équipe connue : l'ancre doit être présente, l'autre id est
        // l'adversaire — on vérifie son nom bo3 contre notre équipe non résolue.
        if (!ids.includes(anchor)) continue;
        const otherId = ids[0] === anchor ? ids[1] : ids[0];
        const otherRef = await this.teamRefById(otherId);
        const otherTeam = idA != null ? teamB : teamA;
        if (otherRef && bo3TeamMatches(otherRef, otherTeam)) {
          return idA != null
            ? { matchId: String(m.id), idA, idB: otherId }
            : { matchId: String(m.id), idA: otherId, idB };
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
      if (idA == null && bo3TeamMatches(ref, teamA)) idA = id;
      else if (idB == null && bo3TeamMatches(ref, teamB)) idB = id;
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
    const list = await this.cached(path, () => this.get<Bo3List<Bo3TeamRef>>(path));
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
    const list = await this.cached(path, () => this.get<Bo3List<Bo3TeamRef>>(path));
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
    const list = await this.cached(path, () => this.get<Bo3List<Bo3TeamRef>>(path));
    const results = list?.results ?? [];
    return results.length === 1 ? results[0] : null;
  }

  /** Fiche équipe bo3 (nom, tag, logo) par id connu — enrichissement CS2 (impossible avec Grid). */
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
