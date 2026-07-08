import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GameId, PANDASCORE_PATHS } from '@esfl/contracts';
import type { PSMatch, PSSerie, PSTeam } from './pandascore.types';

const BASE_URL = 'https://api.pandascore.co';
const PER_PAGE = 100;

@Injectable()
export class PandascoreClient {
  private readonly logger = new Logger(PandascoreClient.name);

  constructor(private readonly config: ConfigService) {}

  /** false tant que PANDASCORE_TOKEN n'est pas renseigné : l'ingestion reste inactive. */
  get enabled(): boolean {
    return Boolean(this.config.get<string>('PANDASCORE_TOKEN'));
  }

  async get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.config.getOrThrow('PANDASCORE_TOKEN')}` },
    });
    if (response.status === 429) {
      // Free tier : 1000 req/h. On attend une minute puis on retente une fois.
      this.logger.warn(`Rate limit Pandascore atteint sur ${path}, retry dans 60s`);
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return this.get<T>(path, params);
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
