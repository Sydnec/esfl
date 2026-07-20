import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GameId, PANDASCORE_PATHS } from '@esfl/contracts';
import type { PSMatch, PSPlayer, PSSerie, PSTeam } from './pandascore.types';

const BASE_URL = 'https://api.pandascore.co';
const PER_PAGE = 100;
/** Espacement minimal entre deux requêtes : ~900 req/h max, sous le quota gratuit de 1000/h. */
const MIN_REQUEST_SPACING_MS = 4_000;

@Injectable()
export class PandascoreClient {
  private readonly logger = new Logger(PandascoreClient.name);
  /** File séquentielle : chaque requête attend la précédente + l'espacement minimal. */
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private requestTimestamps: number[] = [];

  constructor(private readonly config: ConfigService) {}

  /** false tant que PANDASCORE_TOKEN n'est pas renseigné : l'ingestion reste inactive. */
  get enabled(): boolean {
    return Boolean(this.config.get<string>('PANDASCORE_TOKEN'));
  }

  /** Nombre de requêtes émises sur la dernière heure glissante. */
  get requestsLastHour(): number {
    const cutoff = Date.now() - 3_600_000;
    this.requestTimestamps = this.requestTimestamps.filter((ts) => ts > cutoff);
    return this.requestTimestamps.length;
  }

  get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastRequestAt + MIN_REQUEST_SPACING_MS - Date.now();
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      this.lastRequestAt = Date.now();
      this.requestTimestamps.push(this.lastRequestAt);
      return this.fetchOnce<T>(path, params);
    });
    // La file continue même si une requête échoue.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async fetchOnce<T>(path: string, params: Record<string, string | number>): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.config.getOrThrow('PANDASCORE_TOKEN')}` },
    });
    if (response.status === 429) {
      // Quota atteint malgré le throttle : on attend une minute puis on retente une fois.
      this.logger.warn(`Rate limit Pandascore atteint sur ${path}, retry dans 60s`);
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return this.fetchOnce<T>(path, params);
    }
    if (!response.ok) {
      throw new ServiceUnavailableException(`Pandascore ${path} → ${response.status}`);
    }
    return (await response.json()) as T;
  }

  private async getAllPages<T>(
    path: string,
    params: Record<string, string | number> = {},
    maxPages = 5,
  ): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = await this.get<T[]>(path, { ...params, page, per_page: PER_PAGE });
      items.push(...batch);
      if (batch.length < PER_PAGE) break;
    }
    return items;
  }

  /** Séries en cours et à venir pour un jeu. */
  async listActiveSeries(game: GameId): Promise<PSSerie[]> {
    const prefix = PANDASCORE_PATHS[game];
    const [running, upcoming] = await Promise.all([
      this.getAllPages<PSSerie>(`/${prefix}/series/running`, {}, 2),
      this.getAllPages<PSSerie>(`/${prefix}/series/upcoming`, {}, 2),
    ]);
    return [...running, ...upcoming];
  }

  /**
   * Séries passées + en cours + à venir dont l'activité chevauche [since, now]
   * — pour le backfill historique du premier démarrage (base vide). Les séries
   * passées sont filtrées sur leur date de fin (≥ since) ; dédupliquées par id.
   */
  async listSeriesSince(game: GameId, since: Date): Promise<PSSerie[]> {
    const prefix = PANDASCORE_PATHS[game];
    const past = await this.getAllPages<PSSerie>(
      `/${prefix}/series/past`,
      { 'range[end_at]': `${since.toISOString()},${new Date().toISOString()}`, sort: '-begin_at' },
      20,
    );
    const active = await this.listActiveSeries(game);
    const byId = new Map<number, PSSerie>();
    for (const serie of [...past, ...active]) byId.set(serie.id, serie);
    return [...byId.values()];
  }

  listMatchesForSerie(game: GameId, serieId: number): Promise<PSMatch[]> {
    const prefix = PANDASCORE_PATHS[game];
    return this.getAllPages<PSMatch>(`/${prefix}/matches`, {
      'filter[serie_id]': serieId,
      sort: 'begin_at',
    });
  }

  /** Matchs d'une série sur une fenêtre temporelle (1 page) : pour le sync « live ». */
  listMatchesInWindow(game: GameId, serieId: number, from: Date, to: Date): Promise<PSMatch[]> {
    const prefix = PANDASCORE_PATHS[game];
    return this.get<PSMatch[]>(`/${prefix}/matches`, {
      'filter[serie_id]': serieId,
      'range[begin_at]': `${from.toISOString()},${to.toISOString()}`,
      sort: 'begin_at',
      per_page: PER_PAGE,
    });
  }

  async listTeamsWithPlayers(game: GameId, teamIds: number[]): Promise<PSTeam[]> {
    if (teamIds.length === 0) return [];
    const prefix = PANDASCORE_PATHS[game];
    const teams: PSTeam[] = [];
    // filter[id] accepte une liste séparée par des virgules (max ~100 ids par appel)
    for (let i = 0; i < teamIds.length; i += PER_PAGE) {
      const chunk = teamIds.slice(i, i + PER_PAGE);
      teams.push(
        ...(await this.getAllPages<PSTeam>(
          `/${prefix}/teams`,
          { 'filter[id]': chunk.join(',') },
          2,
        )),
      );
    }
    return teams;
  }

  /**
   * Joueurs par pseudo, hors roster d'équipe. `listTeamsWithPlayers` ne voit
   * que les joueurs du roster COURANT d'une équipe donnée : un joueur passé
   * dans une autre structure (académie, transfert) y est invisible, alors
   * qu'il existe bien chez Pandascore. Cet appel permet de le retrouver.
   *
   * `filter[name]` accepte une liste séparée par des virgules et fait une
   * égalité exacte (casse comprise) : l'appelant doit donc rapprocher lui-même
   * sur le pseudo normalisé, et fournir toutes les variantes de casse utiles.
   */
  async listPlayersByNames(game: GameId, names: string[]): Promise<PSPlayer[]> {
    if (names.length === 0) return [];
    const prefix = PANDASCORE_PATHS[game];
    const players: PSPlayer[] = [];
    // Lots de 50 : les pseudos sont plus longs que des ids, on garde l'URL courte.
    for (let i = 0; i < names.length; i += 50) {
      const chunk = names.slice(i, i + 50);
      players.push(
        ...(await this.getAllPages<PSPlayer>(
          `/${prefix}/players`,
          { 'filter[name]': chunk.join(',') },
          2,
        )),
      );
    }
    return players;
  }

  /**
   * Recherche d'un joueur par pseudo, INSENSIBLE À LA CASSE.
   *
   * `filter[name]` compare à la casse exacte, et Pandascore capitalise
   * arbitrairement, y compris au milieu du pseudo (« KRIMZ », « Ax1Le »,
   * « KaRnez », « iDISBALANCE ») : aucune liste de graphies ne peut le deviner.
   * `search[name]` s'en affranchit, mais n'accepte pas de lot — d'où un appel
   * par pseudo, réservé au résidu que la recherche en lot n'a pas trouvé.
   *
   * La recherche est par sous-chaîne : l'appelant doit re-filtrer sur le pseudo
   * normalisé, sans quoi « alex » ramènerait tous les « alexander ».
   */
  async searchPlayerByName(game: GameId, name: string): Promise<PSPlayer[]> {
    const trimmed = name.trim();
    if (!trimmed) return [];
    const prefix = PANDASCORE_PATHS[game];
    return this.get<PSPlayer[]>(`/${prefix}/players`, {
      'search[name]': trimmed,
      per_page: PER_PAGE,
    });
  }
}
