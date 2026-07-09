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

  /**
   * Détail de la ligue vu par cet utilisateur — sert à la fois de contrôle
   * d'appartenance (null si non membre) et de source des compétitions suivies.
   */
  async leagueForUser(
    leagueId: string,
    userId: string,
  ): Promise<{ id: string; competitions: Array<{ competitionId: string }> } | null> {
    const response = await fetch(`${this.baseUrl}/fantasy/leagues/${leagueId}`, {
      headers: { 'x-user-id': userId },
    });
    if (!response.ok) return null;
    return (await response.json()) as { id: string; competitions: Array<{ competitionId: string }> };
  }
}
