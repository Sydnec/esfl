import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PandascoreClient } from '../pandascore/pandascore.client';
import { PrismaService } from '../prisma.service';
import { INGESTION_QUEUE } from './ingestion.constants';

/**
 * Profondeur par défaut du backfill historique au premier démarrage (base
 * vide) : 4 mois glissants. `HISTORY_BACKFILL_SINCE` (date fixe YYYY-MM-DD)
 * reste prioritaire si présent.
 */
const DEFAULT_BACKFILL_MONTHS = 4;

/** Jobs répétables retirés du code, à purger de Redis au démarrage. */
const OBSOLETE_SCHEDULERS = ['check-grid-coverage'];

function defaultBackfillSince(): string {
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - DEFAULT_BACKFILL_MONTHS);
  return since.toISOString().slice(0, 10);
}

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
    await this.dropObsoleteSchedulers();
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
    // Stats live des matchs en cours — jeux dont le provider expose
    // fetchLiveStats : Valorant (page VLR) et CS2 (bo3).
    await this.queue.upsertJobScheduler('sync-live-stats', { every: 3 * 60 * 1000 }, {
      name: 'sync-live-stats',
    });
    // Rattrapage des sources publiées tardivement (une source enregistre
    // parfois un tournoi après la fenêtre de 48h) : ré-arme
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
      const since = this.config.get<string>('HISTORY_BACKFILL_SINCE') ?? defaultBackfillSince();
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

  /**
   * Désenregistre les schedulers d'anciennes versions : un `upsertJobScheduler`
   * survit dans Redis à la suppression de son code, et le processor bouclerait
   * sur « Job inconnu ». Supprimable une fois tous les environnements passés.
   */
  private async dropObsoleteSchedulers(): Promise<void> {
    for (const id of OBSOLETE_SCHEDULERS) {
      try {
        if (await this.queue.removeJobScheduler(id)) {
          this.logger.log(`Scheduler obsolète supprimé : ${id}`);
        }
      } catch (error) {
        this.logger.warn(`Suppression du scheduler ${id} : ${String(error)}`);
      }
    }
  }
}
