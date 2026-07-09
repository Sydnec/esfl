import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Client REST interne vers le scoring-service. */
@Injectable()
export class ScoringClient {
  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    return this.config.get<string>('SCORING_SERVICE_URL') ?? 'http://localhost:4004';
  }

  /**
   * Purge (sans attendre) des scores d'une ligue supprimée, ou d'un membre
   * qui la quitte. Best effort : des scores orphelins n'ont aucun effet, le
   * leaderboard de la ligue disparaissant avec elle.
   */
  removeLeagueScores(leagueId: string, userId?: string): void {
    const path = userId
      ? `/scoring/internal/leagues/${leagueId}/users/${userId}`
      : `/scoring/internal/leagues/${leagueId}`;
    fetch(`${this.baseUrl}${path}`, { method: 'DELETE' }).catch(() => {
      // best effort
    });
  }
}
