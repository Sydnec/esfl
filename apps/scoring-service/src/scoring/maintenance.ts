import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { ScoringService } from './scoring.service';

/** Queue de maintenance du scoring (jobs répétables internes au service). */
export const SCORING_MAINTENANCE_QUEUE = 'scoring-maintenance';

/**
 * Planifie les deux entretiens horaires du scoring :
 *
 * - `backfill-scores` : rattrape les matchs terminés dont les stats sont en
 *   base mais qui n'ont jamais été notés (événement `stats.ingested` perdu,
 *   service indisponible au moment de la publication, stats arrivées après le
 *   gel). Sans lui, ces matchs restent à vie sans note sur les fiches joueurs.
 * - `freeze-days` : les journées passées complètes (ou à l'échéance J+3) sont
 *   re-notées une dernière fois puis gelées — le scoreboard des ligues
 *   fantasy devient immuable.
 *
 * `SCORING_FREEZE_ENABLED=0` désactive le GEL (et retire un scheduler déjà
 * enregistré) : indispensable pendant une ré-ingestion massive, sans quoi
 * l'échéance J+3 gèlerait des journées encore incomplètes avec des
 * distributions de mi-parcours. Réactiver après le reset-scores final. Le
 * rattrapage, lui, ne fige rien : il reste planifié dans tous les cas.
 */
@Injectable()
export class ScoringMaintenanceScheduler implements OnModuleInit {
  private readonly logger = new Logger(ScoringMaintenanceScheduler.name);

  constructor(
    @InjectQueue(SCORING_MAINTENANCE_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    await this.queue.upsertJobScheduler(
      'backfill-scores',
      { every: 3600 * 1000 },
      {
        name: 'backfill-scores',
      },
    );
    this.logger.log('Rattrapage des notes manquantes planifié (toutes les heures)');

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
      case 'backfill-scores':
        await this.scoring.backfillMissingScores();
        break;
      case 'freeze-days':
        await this.scoring.freezeEligibleDays();
        break;
      default:
        this.logger.warn(`Job inconnu : ${job.name}`);
    }
  }
}
