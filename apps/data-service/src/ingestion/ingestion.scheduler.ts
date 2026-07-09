import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PandascoreClient } from '../pandascore/pandascore.client';
import { PrismaService } from '../prisma.service';
import { INGESTION_QUEUE } from './ingestion.constants';

/**
 * Planifie les jobs répétables d'ingestion (uniquement si le token Pandascore
 * est présent). Cadences calibrées pour le free tier (1000 req/h) :
 * le catalogue bouge peu, et seuls les matchs/rosters des compétitions
 * suivies par une ligue sont synchronisés.
 */
@Injectable()
export class IngestionScheduler implements OnModuleInit {
  private readonly logger = new Logger(IngestionScheduler.name);

  constructor(
    @InjectQueue(INGESTION_QUEUE) private readonly queue: Queue,
    private readonly pandascore: PandascoreClient,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    if (!this.pandascore.enabled) {
      this.logger.warn('PANDASCORE_TOKEN absent : ingestion désactivée');
      return;
    }
    await this.queue.upsertJobScheduler('sync-series', { every: 12 * 3600 * 1000 }, {
      name: 'sync-series',
    });
    await this.queue.upsertJobScheduler('sync-matches', { every: 15 * 60 * 1000 }, {
      name: 'sync-matches',
    });
    await this.queue.upsertJobScheduler('sync-rosters', { every: 24 * 3600 * 1000 }, {
      name: 'sync-rosters',
    });
    await this.queue.upsertJobScheduler('sync-live', { every: 3 * 60 * 1000 }, {
      name: 'sync-live',
    });
    this.logger.log(
      'Jobs d’ingestion planifiés (séries 12h, matchs 15min, live 3min, rosters 24h)',
    );

    // Premier démarrage : peuple le catalogue sans attendre le cycle de 12h.
    const competitions = await this.prisma.competition.count();
    if (competitions === 0) {
      await this.queue.add('sync-series', {});
      this.logger.log('Référentiel vide : sync-series lancé immédiatement');
    }

    // Visibilité sur la consommation du quota Pandascore.
    setInterval(
      () => this.logger.log(`Pandascore : ${this.pandascore.requestsLastHour} req sur la dernière heure`),
      3600 * 1000,
    ).unref();
  }
}
