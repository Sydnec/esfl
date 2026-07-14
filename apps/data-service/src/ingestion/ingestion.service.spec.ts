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
    {} as never, // fantasyClient
    {} as never, // liveEvents
    config,
    queue,
  );
  return { service, findMany, add, config };
}

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
