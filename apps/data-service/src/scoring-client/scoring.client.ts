import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Client REST interne vers le scoring-service (suites d'une fusion de fiches). */
@Injectable()
export class ScoringClient {
  private readonly logger = new Logger(ScoringClient.name);

  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    return this.config.get<string>('SCORING_SERVICE_URL') ?? 'http://localhost:4004';
  }

  /**
   * Fait suivre les notes fantasy quand des fiches joueur fusionnent. Les deux
   * schémas sont étanches (aucune clé étrangère possible) : sans cet appel, les
   * notes restent accrochées à une fiche supprimée et la fiche gardée perd son
   * historique.
   *
   * Échec toléré : la fusion, elle, a bien eu lieu. On journalise plutôt que de
   * la faire échouer, un recalcul ultérieur rattrapant le reliquat.
   */
  async playersMerged(keepId: string, absorbedIds: string[]): Promise<void> {
    if (absorbedIds.length === 0) return;
    try {
      const response = await fetch(`${this.baseUrl}/scoring/internal/players/merged`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keepId, absorbedIds }),
      });
      if (!response.ok) {
        this.logger.warn(`scoring players/merged → ${response.status}`);
      }
    } catch (error) {
      this.logger.warn(`scoring-service injoignable : ${String(error)}`);
    }
  }
}
