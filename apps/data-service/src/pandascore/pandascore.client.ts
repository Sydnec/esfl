import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GameId, PANDASCORE_PATHS } from '@esfl/contracts';
import type { PSMatch, PSSerie, PSTeam } from './pandascore.types';

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
}
