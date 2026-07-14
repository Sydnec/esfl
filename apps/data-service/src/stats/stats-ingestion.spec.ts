import { describe, expect, it, vi } from 'vitest';
import type { Match, Team } from '../../generated/client';
import type { PrismaService } from '../prisma.service';
import type { GridStatsProvider } from './grid.provider';
import type { LeaguepediaStatsProvider } from './leaguepedia.provider';
import type { BallchasingStatsProvider } from './ballchasing.provider';
import type { VlrStatsProvider } from './vlr.provider';
import type { MatchContext, ProviderResult } from './provider';
import { StatsIngestionService } from './stats-ingestion';

/**
 * Tests du cœur de l'ingestion (persistResult) avec un Prisma factice :
 * résolution d'identité, création de fiche joueur, fusion des manches et
 * mémorisation de la page source.
 */

type Upsert = { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> };

function fakePrisma() {
  const created: Array<Record<string, unknown>> = [];
  const upserts: Upsert[] = [];
  const matchUpdates: Array<Record<string, unknown>> = [];
  const teamUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
  let nextId = 1;
  const prisma = {
    player: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: `nouveau-${nextId++}`, ...data };
      }),
    },
    playerMatchStats: {
      upsert: vi.fn(async (args: Upsert) => {
        upserts.push(args);
        return args.create;
      }),
    },
    match: {
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        matchUpdates.push(args.data);
        return args.data;
      }),
    },
    team: {
      // Aucune autre équipe connue : le garde-fou anti-vol ne bloque rien.
      findMany: vi.fn(async () => []),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        teamUpdates.push({ id: args.where.id, data: args.data });
        return args.data;
      }),
    },
  };
  return { prisma: prisma as unknown as PrismaService, created, upserts, matchUpdates, teamUpdates };
}

function service(prisma: PrismaService) {
  const queue = { add: vi.fn() };
  const liveEvents = { emitMatchUpdated: vi.fn() };
  return new StatsIngestionService(
    prisma,
    queue as never,
    liveEvents as never,
    { gameId: 'cs2' } as GridStatsProvider,
    { gameId: 'valorant' } as VlrStatsProvider,
    { gameId: 'lol' } as LeaguepediaStatsProvider,
    { gameId: 'rl' } as BallchasingStatsProvider,
  );
}

const match = {
  id: 'match-1',
  name: 'Vitality vs NAVI',
  gameId: 'cs2',
  statsPageUrl: null,
  gamesSummary: null,
} as Match;
const teamA = { id: 'team-a', name: 'Vitality' } as Team;
const teamB = { id: 'team-b', name: 'NAVI' } as Team;

function context(players: Array<{ id: string; name: string; teamId: string }>): MatchContext {
  return { teamA, teamB, players: players as MatchContext['players'] };
}

function line(externalName: string, side: 'A' | 'B' | null): ProviderResult['lines'][number] {
  return { externalName, side, raw: {}, normalized: { kills: 1 } };
}

describe('persistResult', () => {
  it('rattache par pseudo (exact, leet, inclusion) et upsert les stats', async () => {
    const { prisma, upserts, created } = fakePrisma();
    const ingestion = service(prisma);
    const ctx = context([
      { id: 'p1', name: 'ZywOo', teamId: 'team-a' },
      { id: 'p2', name: 'Sh1n', teamId: 'team-b' },
    ]);
    const persisted = await ingestion['persistResult'](match, ctx, 'grid', {
      lines: [line('zywoo', 'A'), line('shin', 'B')],
    });
    expect(persisted).toBe(2);
    expect(created).toHaveLength(0);
    expect(upserts.map((u) => (u.where as { matchId_playerId: { playerId: string } }).matchId_playerId.playerId)).toEqual([
      'p1',
      'p2',
    ]);
  });

  it('crée la fiche d’un inconnu quand son côté est résolu, l’ignore sinon', async () => {
    const { prisma, created, upserts } = fakePrisma();
    const ingestion = service(prisma);
    const persisted = await ingestion['persistResult'](match, context([]), 'grid', {
      lines: [line('NewComer', 'A'), line('Fantôme', null)],
    });
    expect(persisted).toBe(1);
    expect(created).toEqual([
      { gameId: 'cs2', name: 'NewComer', teamId: 'team-a', source: 'grid' },
    ]);
    expect(upserts).toHaveLength(1);
  });

  it('mémorise la page source et fusionne les manches', async () => {
    const { prisma, matchUpdates } = fakePrisma();
    const ingestion = service(prisma);
    await ingestion['persistResult'](match, context([{ id: 'p1', name: 'ZywOo', teamId: 'team-a' }]), 'grid', {
      lines: [line('ZywOo', 'A')],
      games: [{ position: 1, map: 'mirage', scoreA: 13, scoreB: 9 }],
      pageUrl: '2955746',
    });
    const summary = matchUpdates.find((data) => 'gamesSummary' in data);
    expect(summary?.gamesSummary).toEqual([
      { position: 1, map: 'mirage', scoreA: 13, scoreB: 9 },
    ]);
    expect(matchUpdates.find((data) => 'statsPageUrl' in data)?.statsPageUrl).toBe('2955746');
  });

  it('résout côtés + scores de game via les joueurs quand les noms d’équipe diffèrent', async () => {
    const { prisma, matchUpdates, teamUpdates } = fakePrisma();
    const ingestion = service(prisma);
    const ctx = context([
      { id: 'p1', name: 'ZywOo', teamId: 'team-a' }, // Vitality
      { id: 'p2', name: 'Aleksib', teamId: 'team-b' }, // NAVI
    ]);
    // La source nomme les équipes autrement (side null, teamName brut non substring).
    const src = (externalName: string, teamName: string) => ({
      externalName,
      side: null,
      teamName,
      raw: {},
      normalized: { kills: 1 },
    });
    await ingestion['persistResult'](match, ctx, 'vlr', {
      lines: [src('ZywOo', 'Xi Lai'), src('Aleksib', 'Titan')],
      games: [
        {
          position: 1,
          map: 'Ascent',
          teams: [
            { name: 'Xi Lai', score: 13 },
            { name: 'Titan', score: 7 },
          ],
        },
      ],
    });
    // Scores rattachés au bon côté via les joueurs (Xi Lai=team-a=A).
    const summary = matchUpdates.find((data) => 'gamesSummary' in data);
    expect(summary?.gamesSummary).toEqual([{ position: 1, map: 'Ascent', scoreA: 13, scoreB: 7 }]);
    // Alias appris pour les deux équipes.
    expect(
      teamUpdates.map((u) => ({ id: u.id, alias: (u.data.aliases as { push: string }).push })),
    ).toEqual([
      { id: 'team-a', alias: 'Xi Lai' },
      { id: 'team-b', alias: 'Titan' },
    ]);
  });
});
