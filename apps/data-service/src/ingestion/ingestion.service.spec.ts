import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { PrismaService } from '../prisma.service';
import { ingestStatsJobId, STATS_BACKFILL_DAYS } from './ingestion.constants';
import { IngestionService } from './ingestion.service';

/**
 * Tests du rattrapage `retryStatsBackfill` : ré-armement de l'ingestion des
 * matchs terminés sans stats, sur un horizon borné, avec un Prisma/queue factices.
 */

function setup(configValue?: unknown) {
  const findMany = vi.fn(async () => [{ id: 'm1' }, { id: 'm2' }]);
  const prisma = { match: { findMany } } as unknown as PrismaService;
  const add = vi.fn(async () => undefined);
  const getJob = vi.fn(async () => undefined);
  const queue = { add, getJob } as unknown as Queue;
  const config = { get: vi.fn(() => configValue) } as unknown as ConfigService;
  const service = new IngestionService(
    prisma,
    {} as never, // pandascore
    {} as never, // liveEvents
    config,
    queue,
  );
  return { service, findMany, add, config };
}

/** Prisma factice pour flagUnrecoverableCompetitions.
 * `noCoverageByComp` = matchs terminés diagnostiqués `no-coverage`. */
function flagSetup(opts: {
  noCoverageByComp: Array<{ competitionId: string; count: number }>;
  withStats: string[];
  competitions: Array<{ id: string; hidden: boolean }>;
}) {
  const updates: Array<{ id: string; hidden: boolean }> = [];
  const prisma = {
    match: {
      groupBy: vi.fn(async () =>
        opts.noCoverageByComp.map((row) => ({
          competitionId: row.competitionId,
          _count: { _all: row.count },
        })),
      ),
      findMany: vi.fn(async () => opts.withStats.map((id) => ({ competitionId: id }))),
    },
    competition: {
      findMany: vi.fn(async () => opts.competitions),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { hidden: boolean } }) => {
        updates.push({ id: where.id, hidden: data.hidden });
        return data;
      }),
    },
  } as unknown as PrismaService;
  const service = new IngestionService(
    prisma,
    {} as never, // pandascore
    {} as never, // liveEvents
    { get: vi.fn() } as unknown as ConfigService,
    { add: vi.fn(), getJob: vi.fn() } as unknown as Queue,
  );
  return { service, updates };
}

describe('flagUnrecoverableCompetitions', () => {
  it('masque une compétition avec assez de matchs no-coverage et aucune stat', async () => {
    const { service, updates } = flagSetup({
      noCoverageByComp: [{ competitionId: 'xse', count: 36 }],
      withStats: [],
      competitions: [{ id: 'xse', hidden: false }],
    });
    await service.flagUnrecoverableCompetitions();
    expect(updates).toEqual([{ id: 'xse', hidden: true }]);
  });

  it('ne masque pas une compétition jamais tentée (ex. LCK non suivie), avec stats, ou trop peu de no-coverage', async () => {
    const { service, updates } = flagSetup({
      noCoverageByComp: [
        { competitionId: 'covered', count: 36 }, // a des stats
        { competitionId: 'tiny', count: 3 }, // trop peu de no-coverage
        // 'lck' : jamais tentée → aucun no-coverage → absente du groupBy
      ],
      withStats: ['covered'],
      competitions: [
        { id: 'covered', hidden: false },
        { id: 'lck', hidden: false },
        { id: 'tiny', hidden: false },
      ],
    });
    await service.flagUnrecoverableCompetitions();
    expect(updates).toEqual([]);
  });

  it('ré-affiche une compétition masquée si des stats sont finalement arrivées', async () => {
    const { service, updates } = flagSetup({
      noCoverageByComp: [{ competitionId: 'back', count: 36 }],
      withStats: ['back'],
      competitions: [{ id: 'back', hidden: true }],
    });
    await service.flagUnrecoverableCompetitions();
    expect(updates).toEqual([{ id: 'back', hidden: false }]);
  });
});

describe('retryStatsBackfill', () => {
  it('ré-arme l’ingestion de chaque match terminé sans stats dans l’horizon', async () => {
    const { service, findMany, add } = setup();
    const now = Date.now();
    const count = await service.retryStatsBackfill();

    expect(count).toBe(2);
    // Un enqueue par match, dédupliqué par jobId déterministe.
    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls.map((call) => call[2]?.jobId)).toEqual([
      ingestStatsJobId('m1'),
      ingestStatsJobId('m2'),
    ]);

    // Filtre : terminé, sans stats, deux équipes, dans l'horizon par défaut.
    const where = findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      status: 'finished',
      stats: { none: {} },
      teamAId: { not: null },
      teamBId: { not: null },
    });
    const cutoff = (where.scheduledAt.gte as Date).getTime();
    const expected = now - STATS_BACKFILL_DAYS * 24 * 3600 * 1000;
    expect(Math.abs(cutoff - expected)).toBeLessThan(5000);
  });

  it('honore la surcharge env STATS_BACKFILL_DAYS', async () => {
    const { service, findMany } = setup(7);
    const now = Date.now();
    await service.retryStatsBackfill();
    const cutoff = (findMany.mock.calls[0][0].where.scheduledAt.gte as Date).getTime();
    expect(Math.abs(cutoff - (now - 7 * 24 * 3600 * 1000))).toBeLessThan(5000);
  });
});
