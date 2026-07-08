import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface FantasyRoster {
  id: string;
  userId: string;
  leagueId: string;
  picks: Array<{ playerId: string; gameId: string }>;
  matchDay: { date: string };
  league: { id: string; competitions: Array<{ competitionId: string }> };
}

/** Client REST interne vers le fantasy-service. */
@Injectable()
export class FantasyClient {
  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    return this.config.get<string>('FANTASY_SERVICE_URL') ?? 'http://localhost:4003';
  }

  async rostersForDate(date: string): Promise<FantasyRoster[]> {
    const url = new URL(`${this.baseUrl}/fantasy/internal/rosters`);
    url.searchParams.set('date', date);
    const response = await fetch(url);
    if (!response.ok) {
      throw new ServiceUnavailableException(`fantasy-service rosters → ${response.status}`);
    }
    return (await response.json()) as FantasyRoster[];
  }

  /** Vérifie l'appartenance à la ligue en déléguant au fantasy-service. */
  async isMember(leagueId: string, userId: string): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/fantasy/leagues/${leagueId}`, {
      headers: { 'x-user-id': userId },
    });
    return response.ok;
  }
}
