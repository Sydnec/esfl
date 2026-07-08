import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface DataCompetition {
  id: string;
  gameId: string;
  name: string;
  beginAt: string | null;
  endAt: string | null;
}

export interface DataMatch {
  id: string;
  gameId: string;
  competitionId: string;
  status: string;
  scheduledAt: string | null;
  beginAt: string | null;
}

export interface DataPlayer {
  id: string;
  gameId: string;
  name: string;
  role: string | null;
  imageUrl: string | null;
  team: { id: string; name: string; acronym: string | null } | null;
}

/** Client REST interne vers le data-service (référentiel esport). */
@Injectable()
export class DataClient {
  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    return this.config.get<string>('DATA_SERVICE_URL') ?? 'http://localhost:4002';
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new ServiceUnavailableException(`data-service ${path} → ${response.status}`);
    }
    return (await response.json()) as T;
  }

  getCompetition(id: string): Promise<DataCompetition> {
    return this.get<DataCompetition>(`/data/competitions/${id}`);
  }

  listMatches(competitionIds: string[], from?: Date, to?: Date): Promise<DataMatch[]> {
    return this.get<DataMatch[]>('/data/matches', {
      competitionIds: competitionIds.join(','),
      ...(from ? { from: from.toISOString() } : {}),
      ...(to ? { to: to.toISOString() } : {}),
    });
  }

  listPlayers(competitionIds: string[]): Promise<DataPlayer[]> {
    return this.get<DataPlayer[]>('/data/players', { competitionIds: competitionIds.join(',') });
  }

  /** Demande (sans attendre) une synchro immédiate d'une compétition. */
  triggerCompetitionSync(competitionId: string): void {
    fetch(`${this.baseUrl}/data/admin/sync-competition/${competitionId}`, {
      method: 'POST',
    }).catch(() => {
      // best effort : le cycle planifié rattrapera
    });
  }
}
