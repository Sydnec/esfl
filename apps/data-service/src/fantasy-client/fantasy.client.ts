import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Client REST interne vers le fantasy-service (ciblage de l'ingestion). */
@Injectable()
export class FantasyClient {
  private readonly logger = new Logger(FantasyClient.name);

  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    return this.config.get<string>('FANTASY_SERVICE_URL') ?? 'http://localhost:4003';
  }

  /**
   * Compétitions suivies par au moins une ligue. Null si le fantasy-service
   * est injoignable — l'appelant doit alors s'abstenir de synchroniser
   * (protège le quota Pandascore).
   */
  async followedCompetitionIds(): Promise<string[] | null> {
    try {
      const response = await fetch(`${this.baseUrl}/fantasy/internal/followed-competitions`);
      if (!response.ok) {
        this.logger.warn(`fantasy-service followed-competitions → ${response.status}`);
        return null;
      }
      return (await response.json()) as string[];
    } catch (error) {
      this.logger.warn(`fantasy-service injoignable : ${String(error)}`);
      return null;
    }
  }
}
