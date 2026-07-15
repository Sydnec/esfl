import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PandascoreClient } from '../pandascore/pandascore.client';
import { PrismaService } from '../prisma.service';
import { INGESTION_QUEUE } from './ingestion.constants';

/** Date par défaut du backfill historique au premier démarrage (base vide). */
const DEFAULT_BACKFILL_SINCE = '2026-01-01';

/**
 * Planifie les jobs répétables d'ingestion (uniquement si le token Pandascore
 * est présent). Cadences calibrées pour le free tier (1000 req/h) : les
 * matchs de toutes les compétitions actives sont synchronisés (la page
 * d'accueil montre tout le planning), les rosters uniquement pour les
 * compétitions suivies par une ligue, et la fenêtre live ne requête que les
 * compétitions ayant un match imminent ou en cours.
 */
@Injectable()
export class IngestionScheduler implements OnModuleInit {
  private readonly logger = new Logger(IngestionScheduler.name);

  constructor(
    @InjectQueue(INGESTION_QUEUE) private readonly queue: Queue,
    private readonly pandascore: PandascoreClient,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
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
    // Couverture Grid des matchs CS2 (quota Grid indépendant de Pandascore).
    await this.queue.upsertJobScheduler('check-grid-coverage', { every: 30 * 60 * 1000 }, {
      name: 'check-grid-coverage',
    });
    // Stats live des matchs en cours — jeux dont le provider expose
    // fetchLiveStats : Valorant (page VLR) et CS2 (series state Grid).
    await this.queue.upsertJobScheduler('sync-live-stats', { every: 3 * 60 * 1000 }, {
      name: 'sync-live-stats',
    });
    // Rattrapage des sources publiées tardivement (Grid enregistre parfois un
    // tournoi après la fenêtre de 48h, uploads ballchasing en retard) : ré-arme
    // l'ingestion des matchs terminés restés sans stats, sur un horizon large.
    await this.queue.upsertJobScheduler('retry-stats-backfill', { every: 60 * 60 * 1000 }, {
      name: 'retry-stats-backfill',
    });
    this.logger.log(
      'Jobs d’ingestion planifiés (séries 12h, matchs 15min, live 3min, rosters 24h, backfill 1h)',
    );

    // Premier démarrage (base vide) : backfill historique en arrière-plan
    // (catalogue + matchs + stats depuis `HISTORY_BACKFILL_SINCE`, défaut
    // 2026-01-01), au lieu du seul sync-series des séries actives.
    const competitions = await this.prisma.competition.count();
    if (competitions === 0) {
      const since = this.config.get<string>('HISTORY_BACKFILL_SINCE') ?? DEFAULT_BACKFILL_SINCE;
      await this.queue.add(
        'backfill-history',
        { since },
        { attempts: 3, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: true },
      );
      this.logger.log(`Base vide : backfill historique depuis ${since} lancé en arrière-plan`);
    }

    // Visibilité sur la consommation du quota Pandascore.
    setInterval(
      () => this.logger.log(`Pandascore : ${this.pandascore.requestsLastHour} req sur la dernière heure`),
      3600 * 1000,
    ).unref();
  }
}
