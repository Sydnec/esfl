import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface DataMatch {
  id: string;
  gameId: string;
  competitionId: string;
  status: string;
  scheduledAt: string | null;
  beginAt: string | null;
  endAt: string | null;
}

export interface DataPlayerMatchStats {
  id: string;
  matchId: string;
  playerId: string;
  gameId: string;
  source: string;
  normalized: unknown;
}

/** Client REST interne vers le data-service. */
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

  async getMatch(id: string): Promise<DataMatch> {
    const match = await this.get<DataMatch | null>(`/data/matches/${id}`);
    if (!match) {
      throw new NotFoundException(`Match inconnu : ${id}`);
    }
    return match;
  }

  listMatches(competitionIds: string[], from: Date, to: Date): Promise<DataMatch[]> {
    return this.get<DataMatch[]>('/data/matches', {
      competitionIds: competitionIds.join(','),
      from: from.toISOString(),
      to: to.toISOString(),
    });
  }

  listStats(matchIds: string[]): Promise<DataPlayerMatchStats[]> {
    return this.get<DataPlayerMatchStats[]>('/data/stats', { matchIds: matchIds.join(',') });
  }
}
