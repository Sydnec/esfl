import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma.service';
import { CatalogService } from './catalog.service';

/**
 * Fusion des fiches joueur en double, avec un Prisma factice : choix de la
 * fiche gardée, rapatriement des stats (dont le conflit matchId+playerId),
 * refus de fusionner de vrais homonymes, et innocuité du dry-run.
 */

type Player = {
  id: string;
  gameId: string;
  teamId: string | null;
  name: string;
  pandascoreId: number | null;
  providerIds?: Record<string, string> | null;
};

function fakePrisma(players: Player[], stats: Array<{ id: string; playerId: string; matchId: string }>) {
  const statsUpdates: Array<{ where: unknown; data: unknown }> = [];
  const statsDeletes: string[] = [];
  const playerUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const deletedPlayers: string[] = [];

  const tx = {
    playerMatchStats: {
      findMany: vi.fn(async (args: { where: { playerId: string | { in: string[] } } }) => {
        const target = args.where.playerId;
        const ids = typeof target === 'string' ? [target] : target.in;
        return stats.filter((row) => ids.includes(row.playerId));
      }),
      deleteMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
        statsDeletes.push(...args.where.id.in);
        return { count: args.where.id.in.length };
      }),
      updateMany: vi.fn(async (args: { where: unknown; data: unknown }) => {
        statsUpdates.push(args);
        return { count: 0 };
      }),
    },
    player: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        players.filter((p) => args.where.id.in.includes(p.id)),
      ),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        playerUpdates.push({ id: args.where.id, data: args.data });
        return args.data;
      }),
      deleteMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
        deletedPlayers.push(...args.where.id.in);
        return { count: args.where.id.in.length };
      }),
    },
  };

  const prisma = {
    player: {
      findMany: vi.fn(async () => players),
    },
    playerMatchStats: {
      groupBy: vi.fn(async () => {
        const counts = new Map<string, number>();
        for (const row of stats) counts.set(row.playerId, (counts.get(row.playerId) ?? 0) + 1);
        return [...counts].map(([playerId, count]) => ({ playerId, _count: { _all: count } }));
      }),
    },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return {
    prisma: prisma as unknown as PrismaService,
    statsUpdates,
    statsDeletes,
    playerUpdates,
    deletedPlayers,
  };
}

function service(prisma: PrismaService) {
  return new CatalogService(prisma);
}

describe('mergeDuplicatePlayers', () => {
  it('garde la fiche qui porte l’identité Pandascore et absorbe les autres', async () => {
    const players: Player[] = [
      { id: 'orphelin', gameId: 'cs2', teamId: 'g2', name: 'NertZ', pandascoreId: null },
      { id: 'adoptee', gameId: 'cs2', teamId: 'g2', name: 'NertZ', pandascoreId: 24880 },
    ];
    const { prisma, deletedPlayers, statsUpdates } = fakePrisma(players, [
      { id: 's1', playerId: 'orphelin', matchId: 'm1' },
    ]);
    const res = await service(prisma).mergeDuplicatePlayers('same-team', false);
    expect(res).toMatchObject({ groupes: 1, fichesAbsorbees: 1, statsDeplacees: 1 });
    expect(deletedPlayers).toEqual(['orphelin']);
    expect(statsUpdates[0]).toMatchObject({ data: { playerId: 'adoptee' } });
  });

  it('sans identité Pandascore, garde la fiche la plus fournie en stats', async () => {
    const players: Player[] = [
      { id: 'maigre', gameId: 'cs2', teamId: 'g2', name: 'tAk', pandascoreId: null },
      { id: 'fournie', gameId: 'cs2', teamId: 'g2', name: 'tAk', pandascoreId: null },
    ];
    const { prisma, deletedPlayers } = fakePrisma(players, [
      { id: 's1', playerId: 'fournie', matchId: 'm1' },
      { id: 's2', playerId: 'fournie', matchId: 'm2' },
      { id: 's3', playerId: 'maigre', matchId: 'm3' },
    ]);
    await service(prisma).mergeDuplicatePlayers('same-team', false);
    expect(deletedPlayers).toEqual(['maigre']);
  });

  it('ne fusionne jamais deux fiches portant chacune un id Pandascore (homonymes)', async () => {
    const players: Player[] = [
      { id: 'alex-a', gameId: 'cs2', teamId: null, name: 'alex', pandascoreId: 111 },
      { id: 'alex-b', gameId: 'cs2', teamId: null, name: 'ALEX', pandascoreId: 222 },
    ];
    const { prisma, deletedPlayers } = fakePrisma(players, []);
    const res = await service(prisma).mergeDuplicatePlayers('cross-team', false);
    expect(res.groupes).toBe(0);
    expect(deletedPlayers).toEqual([]);
  });

  it('conflit matchId+playerId : la ligne de la fiche absorbée est supprimée, pas réaffectée', async () => {
    const players: Player[] = [
      { id: 'garde', gameId: 'lol', teamId: 't1', name: 'Faker', pandascoreId: 585 },
      { id: 'double', gameId: 'lol', teamId: 't1', name: 'Faker', pandascoreId: null },
    ];
    // Les deux fiches ont une ligne sur m1 : celle du double doit sauter.
    const { prisma, statsDeletes, statsUpdates } = fakePrisma(players, [
      { id: 'garde-m1', playerId: 'garde', matchId: 'm1' },
      { id: 'double-m1', playerId: 'double', matchId: 'm1' },
      { id: 'double-m2', playerId: 'double', matchId: 'm2' },
    ]);
    await service(prisma).mergeDuplicatePlayers('same-team', false);
    expect(statsDeletes).toEqual(['double-m1']);
    expect(statsUpdates).toHaveLength(1);
  });

  it('le dry-run ne touche à rien mais rapporte le détail', async () => {
    const players: Player[] = [
      { id: 'a', gameId: 'cs2', teamId: 'g2', name: 'MATYS', pandascoreId: 32951 },
      { id: 'b', gameId: 'cs2', teamId: 'g2', name: 'MATYS', pandascoreId: null },
    ];
    const { prisma, deletedPlayers, statsUpdates } = fakePrisma(players, [
      { id: 's1', playerId: 'b', matchId: 'm1' },
    ]);
    const res = await service(prisma).mergeDuplicatePlayers('same-team', true);
    expect(res).toMatchObject({ dryRun: true, groupes: 1, fichesAbsorbees: 1 });
    expect(deletedPlayers).toEqual([]);
    expect(statsUpdates).toEqual([]);
  });

  it('équipes différentes : ignorées en same-team, regroupées en cross-team', async () => {
    const players: Player[] = [
      { id: 'main', gameId: 'lol', teamId: 't1', name: 'Guardian', pandascoreId: 63309 },
      { id: 'academy', gameId: 'lol', teamId: 't1-academy', name: 'Guardian', pandascoreId: null },
    ];
    const sameTeam = await service(fakePrisma(players, []).prisma).mergeDuplicatePlayers(
      'same-team',
      true,
    );
    expect(sameTeam.groupes).toBe(0);
    const crossTeam = await service(fakePrisma(players, []).prisma).mergeDuplicatePlayers(
      'cross-team',
      true,
    );
    expect(crossTeam.groupes).toBe(1);
  });
});
