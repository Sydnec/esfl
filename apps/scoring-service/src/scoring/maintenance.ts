import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { ScoringService } from './scoring.service';

/** Queue de maintenance du scoring (jobs répétables internes au service). */
export const SCORING_MAINTENANCE_QUEUE = 'scoring-maintenance';

/**
 * Planifie le gel automatique des journées : toutes les heures, les journées
 * passées complètes (ou à l'échéance J+3) sont re-notées une dernière fois
 * puis gelées — le scoreboard des ligues fantasy devient immuable.
 *
 * `SCORING_FREEZE_ENABLED=0` désactive le cron (et retire un scheduler déjà
 * enregistré) : indispensable pendant une ré-ingestion massive, sans quoi
 * l'échéance J+3 gèlerait des journées encore incomplètes avec des
 * distributions de mi-parcours. Réactiver après le reset-scores final.
 */
@Injectable()
export class ScoringMaintenanceScheduler implements OnModuleInit {
  private readonly logger = new Logger(ScoringMaintenanceScheduler.name);

  constructor(
    @InjectQueue(SCORING_MAINTENANCE_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    if (this.config.get<string>('SCORING_FREEZE_ENABLED') === '0') {
      await this.queue.removeJobScheduler('freeze-days').catch(() => undefined);
      this.logger.warn('Gel des journées désactivé (SCORING_FREEZE_ENABLED=0)');
      return;
    }
    await this.queue.upsertJobScheduler(
      'freeze-days',
      { every: 3600 * 1000 },
      {
        name: 'freeze-days',
      },
    );
    this.logger.log('Gel des journées planifié (contrôle toutes les heures)');
  }
}

@Processor(SCORING_MAINTENANCE_QUEUE)
export class ScoringMaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(ScoringMaintenanceProcessor.name);

  constructor(private readonly scoring: ScoringService) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case 'freeze-days':
        await this.scoring.freezeEligibleDays();
        break;
      default:
        this.logger.warn(`Job inconnu : ${job.name}`);
    }
  }
}
