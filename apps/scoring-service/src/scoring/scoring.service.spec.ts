import { describe, expect, it, vi } from 'vitest';
import { parisDate } from '@esfl/contracts';
import type { PrismaService } from '../prisma.service';
import type { DataClient } from '../clients/data.client';
import type { FantasyClient } from '../clients/fantasy.client';
import { ScoringService } from './scoring.service';

/**
 * Tests du gel des journées : une date gelée est immuable (recalculs bloqués,
 * bascules épargnées) et le cron gèle les journées complètes ou à l'échéance.
 */

const daysAgo = (days: number) => parisDate(new Date(Date.now() - days * 24 * 3600 * 1000));

function setup(opts: {
  frozen?: string[];
  match?: Record<string, unknown>;
  scoredMatches?: Record<string, Record<string, unknown>>;
  completenessByDate?: Record<string, Record<string, unknown>>;
}) {
  const frozenUpserts: Array<Record<string, unknown>> = [];
  const deletes: Array<{ table: string; where: unknown }> = [];
  const prisma = {
    frozenMatchDay: {
      findMany: vi.fn(async () => (opts.frozen ?? []).map((date) => ({ date }))),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
        frozenUpserts.push(create);
        return create;
      }),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    rosterScore: {
      count: vi.fn(async () => 0),
      deleteMany: vi.fn(async (args: { where?: unknown } = {}) => {
        deletes.push({ table: 'rosterScore', where: args.where ?? null });
        return { count: 0 };
      }),
    },
    fantasyPoints: {
      findMany: vi.fn(async () =>
        Object.keys(opts.scoredMatches ?? {}).map((matchId) => ({ matchId })),
      ),
      deleteMany: vi.fn(async (args: { where?: unknown } = {}) => {
        deletes.push({ table: 'fantasyPoints', where: args.where ?? null });
        return { count: 0 };
      }),
      upsert: vi.fn(async () => ({})),
    },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  } as unknown as PrismaService;
  const data = {
    getMatch: vi.fn(async (id: string) => {
      const match = opts.match ?? opts.scoredMatches?.[id];
      if (!match) throw new Error('inconnu');
      return match;
    }),
    listStats: vi.fn(async () => []),
    listStatsMatchIds: vi.fn(async () => []),
    getScoringStats: vi.fn(async () => []),
    listMatches: vi.fn(async () => []),
    dayCompleteness: vi.fn(async (date: string) => {
      const completeness = opts.completenessByDate?.[date];
      if (!completeness) throw new Error('indisponible');
      return { date, scoredMatchIds: [], ...completeness };
    }),
  } as unknown as DataClient;
  const fantasy = { rostersForDate: vi.fn(async () => []) } as unknown as FantasyClient;
  const service = new ScoringService(prisma, data, fantasy);
  return { service, prisma, data, frozenUpserts, deletes };
}

describe('gel des journées', () => {
  it('computeForMatch ignore un match d’une journée gelée (gel absolu)', async () => {
    const date = daysAgo(2);
    const { service, prisma } = setup({
      frozen: [date],
      match: { id: 'm1', name: 'X vs Y', beginAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString() },
    });
    const result = await service.computeForMatch('m1');
    expect(result).toEqual({ playersScored: 0, rostersUpdated: 0 });
    // Aucune note écrite pour une journée gelée.
    expect(prisma.fantasyPoints.upsert).not.toHaveBeenCalled();
  });

  it('resetAndRecompute épargne les points et scores des journées gelées', async () => {
    const frozenDate = daysAgo(5);
    const { service, deletes } = setup({
      frozen: [frozenDate],
      scoredMatches: {
        gelé: { id: 'gelé', name: 'A vs B', beginAt: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString() },
        libre: { id: 'libre', name: 'C vs D', beginAt: new Date().toISOString() },
      },
    });
    await service.resetAndRecompute();
    const rosterDelete = deletes.find((entry) => entry.table === 'rosterScore');
    expect(rosterDelete?.where).toEqual({ matchDayDate: { notIn: [frozenDate] } });
    const pointsDelete = deletes.find((entry) => entry.table === 'fantasyPoints');
    expect(pointsDelete?.where).toEqual({ matchId: { notIn: ['gelé'] } });
  });

  it('freezeEligibleDays gèle une journée complète et une journée à l’échéance', async () => {
    const complete = daysAgo(1);
    const recentIncomplete = daysAgo(2);
    const deadline = daysAgo(3);
    const { service, frozenUpserts } = setup({
      completenessByDate: {
        [complete]: { totalMatches: 4, pendingCount: 0, missingCount: 0, complete: true },
        [recentIncomplete]: { totalMatches: 3, pendingCount: 0, missingCount: 1, complete: false },
        [deadline]: { totalMatches: 3, pendingCount: 0, missingCount: 2, complete: false },
      },
    });
    const frozen = await service.freezeEligibleDays();
    expect(frozen).toEqual([complete, deadline]);
    expect(frozenUpserts).toEqual([
      { date: complete, reason: 'complete' },
      { date: deadline, reason: 'deadline' },
    ]);
  });

  it('ne gèle pas une journée sans activité ni une journée déjà gelée', async () => {
    const empty = daysAgo(1);
    const already = daysAgo(4);
    const { service, frozenUpserts } = setup({
      frozen: [already],
      completenessByDate: {
        [empty]: { totalMatches: 0, pendingCount: 0, missingCount: 0, complete: true },
        [already]: { totalMatches: 2, pendingCount: 0, missingCount: 0, complete: true },
      },
    });
    expect(await service.freezeEligibleDays()).toEqual([]);
    expect(frozenUpserts).toEqual([]);
  });
});
