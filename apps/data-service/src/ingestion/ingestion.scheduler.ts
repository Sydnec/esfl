import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PandascoreClient } from '../pandascore/pandascore.client';
import { INGESTION_QUEUE } from './ingestion.processor';

/** Planifie les jobs répétables d'ingestion (uniquement si le token Pandascore est présent). */
@Injectable()
export class IngestionScheduler implements OnModuleInit {
  private readonly logger = new Logger(IngestionScheduler.name);

  constructor(
    @InjectQueue(INGESTION_QUEUE) private readonly queue: Queue,
    private readonly pandascore: PandascoreClient,
  ) {}

  async onModuleInit() {
    if (!this.pandascore.enabled) {
      this.logger.warn('PANDASCORE_TOKEN absent : ingestion désactivée');
      return;
    }
    await this.queue.upsertJobScheduler('sync-series', { every: 6 * 3600 * 1000 }, {
      name: 'sync-series',
    });
    await this.queue.upsertJobScheduler('sync-matches', { every: 10 * 60 * 1000 }, {
      name: 'sync-matches',
    });
    await this.queue.upsertJobScheduler('sync-rosters', { every: 12 * 3600 * 1000 }, {
      name: 'sync-rosters',
    });
    this.logger.log('Jobs d’ingestion planifiés (séries 6h, matchs 10min, rosters 12h)');
  }
}
