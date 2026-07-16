import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { StatsIngestionService } from '../stats/stats-ingestion';
import { INGESTION_QUEUE, IngestionJobName } from './ingestion.constants';
import { IngestionService } from './ingestion.service';
import { TeamEnrichmentService } from './team-enrichment.service';

export { INGESTION_QUEUE };
export type { IngestionJobName };

@Processor(INGESTION_QUEUE)
export class IngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(IngestionProcessor.name);

  constructor(
    private readonly ingestion: IngestionService,
    private readonly statsIngestion: StatsIngestionService,
    private readonly teamEnrichment: TeamEnrichmentService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    this.logger.log(`Job ${job.name} démarré${job.attemptsMade ? ` (tentative ${job.attemptsMade + 1})` : ''}`);
    switch (job.name as IngestionJobName) {
      case 'sync-series':
        await this.ingestion.syncSeries();
        break;
      case 'sync-matches':
        await this.ingestion.syncAllActiveMatches();
        break;
      case 'sync-rosters':
        await this.ingestion.syncAllActiveRosters();
        break;
      case 'sync-live':
        await this.ingestion.syncLiveWindow();
        break;
      case 'sync-competition':
        await this.ingestion.syncCompetition((job.data as { competitionId: string }).competitionId);
        break;
      case 'check-grid-coverage':
        await this.statsIngestion.checkGridCoverage();
        break;
      case 'sync-live-stats':
        await this.statsIngestion.syncLiveStats();
        break;
      case 'backfill-history': {
        // Premier démarrage (base vide) : ingestion de tout l'historique.
        const since = (job.data as { since?: string }).since;
        await this.ingestion.backfillHistory(since ? new Date(since) : new Date('2026-01-01'));
        break;
      }
      case 'retry-stats-backfill':
        // Masque d'abord les irrécupérables (le backfill les saute ensuite),
        // puis ré-arme l'ingestion des matchs encore récupérables.
        await this.ingestion.flagUnrecoverableCompetitions();
        await this.ingestion.retryStatsBackfill();
        break;
      case 'ingest-stats': {
        // Throw si les stats ne sont pas encore publiées → retry BullMQ (backoff).
        const data = job.data as { matchId: string; force?: boolean };
        await this.statsIngestion.ingestForMatchId(data.matchId, data.force ?? false);
        break;
      }
      case 'enrich-team':
        await this.teamEnrichment.enrichTeam((job.data as { teamId: string }).teamId);
        break;
      case 'backfill-team-players':
        await this.ingestion.backfillTeamPlayers(
          (job.data as { competitionId: string }).competitionId,
        );
        break;
      default:
        this.logger.warn(`Job inconnu : ${job.name}`);
    }
  }
}
