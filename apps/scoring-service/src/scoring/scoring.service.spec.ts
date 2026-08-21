import { describe, expect, it, vi } from 'vitest';
import { FREEZE_DEADLINE_DAYS, parisDate } from '@esfl/contracts';
import type { PrismaService } from '../prisma.service';
import type { DataClient } from '../clients/data.client';
import type { FantasyClient } from '../clients/fantasy.client';
import { picksComptes, ScoringService } from './scoring.service';

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
  /** Matchs déjà notés (défaut : tous les `scoredMatches`). */
  notes?: string[];
  /** Matchs terminés ayant des stats en base, vus par le data-service. */
  statsMatchIds?: string[];
  /** Lignes de stats rendues pour chaque match (sinon aucune, donc aucune note). */
  stats?: Array<Record<string, unknown>>;
}) {
  const frozenUpserts: Array<Record<string, unknown>> = [];
  const deletes: Array<{ table: string; where: unknown }> = [];
  const notes = opts.notes ?? Object.keys(opts.scoredMatches ?? {});
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
      findMany: vi.fn(async () => notes.map((matchId) => ({ matchId }))),
      count: vi.fn(async ({ where }: { where: { matchId: string } }) =>
        notes.includes(where.matchId) ? 5 : 0,
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
    listStats: vi.fn(async () => opts.stats ?? []),
    listStatsMatchIds: vi.fn(async () => opts.statsMatchIds ?? []),
    getScoringStats: vi.fn(async () => []),
    listMatches: vi.fn(async () => []),
    dayCompleteness: vi.fn(async (date: string) => {
      const completeness = opts.completenessByDate?.[date];
      if (!completeness) throw new Error('indisponible');
      return { date, scoredMatchIds: [], ...completeness };
    }),
  } as unknown as DataClient;
  const fantasy = { rostersForDate: vi.fn(async () => []) } as unknown as FantasyClient & {
    rostersForDate: ReturnType<typeof vi.fn>;
  };
  const service = new ScoringService(prisma, data, fantasy);
  return { service, prisma, data, fantasy, frozenUpserts, deletes };
}

/** Une ligne de stats CS2 minimale : de quoi produire une note. */
const LIGNE_CS2 = {
  playerId: 'p1',
  gameId: 'cs2',
  normalized: { kills: 20, deaths: 15, assists: 4, adr: 80, kast: 72 },
  role: null,
  teamSide: 'A',
};

describe('gel des journées', () => {
  it('computeForMatch ignore un match d’une journée gelée (gel absolu)', async () => {
    const date = daysAgo(2);
    const { service, prisma, fantasy } = setup({
      frozen: [date],
      notes: [],
      // Des stats sont bien là : c'est le gel, et lui seul, qui refuse la note.
      stats: [LIGNE_CS2],
      match: {
        id: 'm1',
        name: 'X vs Y',
        gameId: 'cs2',
        status: 'finished',
        beginAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
      },
    });
    const result = await service.computeForMatch('m1');
    expect(result).toEqual({ playersScored: 0, rostersUpdated: 0 });
    // Aucune note écrite, aucun score de roster touché.
    expect(prisma.fantasyPoints.upsert).not.toHaveBeenCalled();
    expect(fantasy.rostersForDate).not.toHaveBeenCalled();
  });

  it('resetAndRecompute épargne les points et scores des journées gelées', async () => {
    const frozenDate = daysAgo(5);
    const { service, deletes } = setup({
      frozen: [frozenDate],
      scoredMatches: {
        gelé: {
          id: 'gelé',
          name: 'A vs B',
          beginAt: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
        },
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
    // Incomplète mais AVANT l'échéance : elle reste ouverte, une stat tardive
    // peut encore produire sa note.
    const recentIncomplete = daysAgo(FREEZE_DEADLINE_DAYS - 1);
    const deadline = daysAgo(FREEZE_DEADLINE_DAYS);
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

describe('picksComptes', () => {
  it('écarte le pick dont le match n’a pas été récupéré', () => {
    const notes = new Map([['a', 80]]);
    expect(picksComptes(['a', 'b'], notes, new Set(['b']))).toEqual(['a']);
  });

  it('garde le pick resté sur le banc : son match, lui, est récupéré', () => {
    const notes = new Map([['a', 80]]);
    expect(picksComptes(['a', 'b'], notes, new Set())).toEqual(['a', 'b']);
  });

  it('garde un joueur noté ailleurs le même jour, même signalé non couvert', () => {
    const notes = new Map([['a', 80]]);
    expect(picksComptes(['a'], notes, new Set(['a']))).toEqual(['a']);
  });

  it('rend une liste vide quand toute la journée est un trou', () => {
    expect(picksComptes(['a', 'b'], new Map(), new Set(['a', 'b']))).toEqual([]);
  });
});

/**
 * `stats.ingested` est le seul déclencheur du scoring : un événement perdu
 * (service en cours de redémarrage, lecture data en échec) laissait le match
 * avec ses stats affichées et sans note, définitivement. Le balayage horaire
 * rattrape l'écart entre matchs terminés ayant des stats et matchs notés.
 */
describe('rattrapage des matchs sans note', () => {
  const hier = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  it('note les matchs qui ont des stats mais aucune note, et laisse les autres', async () => {
    const { service, prisma, data } = setup({
      statsMatchIds: ['noté', 'oublié'],
      notes: ['noté'],
      stats: [LIGNE_CS2],
      scoredMatches: {
        noté: { id: 'noté', name: 'A vs B', gameId: 'cs2', status: 'finished', beginAt: hier },
        oublié: { id: 'oublié', name: 'C vs D', gameId: 'cs2', status: 'finished', beginAt: hier },
      },
    });
    const result = await service.backfillMissingScores();
    expect(result).toEqual({ missing: 1, scored: 1 });
    // Seul le match oublié est relu côté data, et seul lui est noté.
    expect(data.getMatch).toHaveBeenCalledExactlyOnceWith('oublié');
    expect(prisma.fantasyPoints.upsert).toHaveBeenCalledOnce();
  });

  it('ne touche à rien quand tous les matchs à stats sont notés', async () => {
    const { service, prisma, data } = setup({
      statsMatchIds: ['a', 'b'],
      notes: ['a', 'b'],
      stats: [LIGNE_CS2],
    });
    expect(await service.backfillMissingScores()).toEqual({ missing: 0, scored: 0 });
    expect(data.getMatch).not.toHaveBeenCalled();
    expect(prisma.fantasyPoints.upsert).not.toHaveBeenCalled();
  });

  it('poursuit le lot malgré un match disparu côté data', async () => {
    const { service, prisma } = setup({
      statsMatchIds: ['fantôme', 'oublié'],
      notes: [],
      stats: [LIGNE_CS2],
      scoredMatches: {
        oublié: { id: 'oublié', name: 'C vs D', gameId: 'cs2', status: 'finished', beginAt: hier },
      },
    });
    // « fantôme » n'existe plus côté data : getMatch lève, le lot continue.
    expect(await service.backfillMissingScores()).toEqual({ missing: 2, scored: 1 });
    expect(prisma.fantasyPoints.upsert).toHaveBeenCalledOnce();
  });
});
