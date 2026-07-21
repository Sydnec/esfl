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

/** Borne basse du filtre `scheduledAt` du dernier appel Prisma capturé. */
function bornePlanifiee(where: Record<string, unknown> | undefined): number {
  const scheduledAt = (where ?? {}).scheduledAt as { gte?: Date } | undefined;
  if (!scheduledAt?.gte) throw new Error('filtre scheduledAt absent');
  return scheduledAt.gte.getTime();
}

/**
 * Providers factices : le service ne lit d'eux que `gameId`, `source` et la
 * présence de `fetchStarters`. CS2 n'expose pas de roster pré-match, ce qui est
 * exactement ce que les traitements testent.
 */
function providersFactices() {
  return [
    { gameId: 'cs2', source: 'bo3' } as never,
    { gameId: 'valorant', source: 'vlr', fetchStarters: vi.fn() } as never,
    { gameId: 'lol', source: 'leaguepedia', fetchStarters: vi.fn() } as never,
  ] as const;
}

function setup(configValue?: unknown) {
  const findMany = vi.fn(async (_args?: { where?: Record<string, unknown> }) => [
    { id: 'm1' },
    { id: 'm2' },
  ]);
  const prisma = { match: { findMany } } as unknown as PrismaService;
  const add = vi.fn(async (_name?: string, _data?: unknown, _opts?: { jobId?: string }) => undefined);
  const getJob = vi.fn(async () => undefined);
  const queue = { add, getJob } as unknown as Queue;
  const config = { get: vi.fn(() => configValue) } as unknown as ConfigService;
  const service = new IngestionService(
    prisma,
    {} as never, // pandascore
    {} as never, // liveEvents
    config,
    ...providersFactices(),
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
    ...providersFactices(),
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
    const where = findMany.mock.calls[0][0]?.where;
    expect(where).toMatchObject({
      status: 'finished',
      stats: { none: {} },
      teamAId: { not: null },
      teamBId: { not: null },
    });
    const cutoff = bornePlanifiee(where);
    const expected = now - STATS_BACKFILL_DAYS * 24 * 3600 * 1000;
    expect(Math.abs(cutoff - expected)).toBeLessThan(5000);
  });

  it('honore la surcharge env STATS_BACKFILL_DAYS', async () => {
    const { service, findMany } = setup(7);
    const now = Date.now();
    await service.retryStatsBackfill();
    const cutoff = bornePlanifiee(findMany.mock.calls[0][0]?.where);
    expect(Math.abs(cutoff - (now - 7 * 24 * 3600 * 1000))).toBeLessThan(5000);
  });
});

/** Prisma + Pandascore factices pour le sync roster repurposé (jeu cs2 : pas de
 * source spécialisée, le fallback Pandascore de reconcileActiveRoster s'applique). */
function rosterSetup(opts: {
  localPlayers: Array<Record<string, unknown>>;
  pandascorePlayers: Array<{ id: number; name: string; role?: string | null }>;
}) {
  const created: Array<Record<string, unknown>> = [];
  const playerUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const updateManys: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const localTeam = { id: 'team-a', pandascoreId: 10, gameId: 'cs2', name: 'Vitality' };
  const prisma = {
    competition: {
      findUnique: vi.fn(async () => ({
        id: 'comp-1',
        gameId: 'cs2',
        teams: [{ team: localTeam }],
      })),
    },
    team: { findUnique: vi.fn(async () => localTeam) },
    player: {
      findMany: vi.fn(async ({ where }: { where: { pandascoreId?: null } }) =>
        opts.localPlayers.filter((player) =>
          where.pandascoreId === null ? player.pandascoreId === null : true,
        ),
      ),
      findUnique: vi.fn(async ({ where }: { where: { pandascoreId: number } }) =>
        opts.localPlayers.find((player) => player.pandascoreId === where.pandascoreId) ?? null,
      ),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        playerUpdates.push({ id: args.where.id, data: args.data });
        return args.data;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'created', ...data };
      }),
      updateMany: vi.fn(
        async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          updateManys.push(args);
          return { count: 0 };
        },
      ),
    },
  } as unknown as PrismaService;
  const pandascore = {
    listTeamsWithPlayers: vi.fn(async () => [
      {
        id: 10,
        players: opts.pandascorePlayers.map((player) => ({
          id: player.id,
          name: player.name,
          first_name: 'Prénom',
          last_name: 'Nom',
          image_url: 'ps.png',
          role: player.role ?? null,
          nationality: 'FR',
        })),
      },
    ]),
  };
  const service = new IngestionService(
    prisma,
    pandascore as never,
    {} as never,
    { get: vi.fn() } as unknown as ConfigService,
    ...providersFactices(),
    { add: vi.fn(), getJob: vi.fn() } as unknown as Queue,
  );
  return { service, created, playerUpdates, updateManys };
}

describe('syncRostersForCompetition (repurposé : adoption + fallback, zéro création)', () => {
  it('ne crée plus de joueur inconnu côté provider', async () => {
    const { service, created } = rosterSetup({
      localPlayers: [],
      pandascorePlayers: [{ id: 500, name: 'Recrue' }],
    });
    await service.syncRostersForCompetition('comp-1');
    expect(created).toHaveLength(0);
  });

  it('complète un joueur existant sans écraser les champs provider ni son équipe', async () => {
    const { service, playerUpdates } = rosterSetup({
      localPlayers: [
        {
          id: 'p1',
          pandascoreId: 500,
          name: 'Zyw0o', // graphie provider, possédée
          teamId: 'team-b', // transféré : le roster courant appartient aux matchs
          fieldSources: { name: 'vlr' },
        },
      ],
      pandascorePlayers: [{ id: 500, name: 'ZywOo' }],
    });
    await service.syncRostersForCompetition('comp-1');
    const update = playerUpdates.find((u) => u.id === 'p1');
    expect(update?.data).not.toHaveProperty('name');
    expect(update?.data).not.toHaveProperty('teamId');
    expect(update?.data).toMatchObject({ firstName: 'Prénom', nationality: 'FR' });
  });

  it('adopte un orphelin par nom : pandascoreId posé, source et champs provider intacts', async () => {
    const { service, playerUpdates } = rosterSetup({
      localPlayers: [
        {
          id: 'orphelin',
          pandascoreId: null,
          name: 'NewComer',
          teamId: 'team-a',
          source: 'grid',
          fieldSources: { name: 'grid' },
        },
      ],
      pandascorePlayers: [{ id: 501, name: 'NewComer' }],
    });
    await service.syncRostersForCompetition('comp-1');
    const adoption = playerUpdates.find((u) => u.id === 'orphelin');
    expect(adoption?.data).toMatchObject({ pandascoreId: 501 });
    expect(adoption?.data).not.toHaveProperty('source');
    expect(adoption?.data).not.toHaveProperty('name');
  });

  it('le fallback actif Pandascore épargne les fiches provider non adoptées', async () => {
    const { service, updateManys } = rosterSetup({
      localPlayers: [],
      pandascorePlayers: [{ id: 500, name: 'Titulaire' }],
    });
    await service.syncRostersForCompetition('comp-1');
    const deactivation = updateManys.find((u) => u.data.active === false);
    expect(deactivation?.where).toMatchObject({ pandascoreId: { not: null } });
  });
});

describe('applyStarterRoster (enrichissement provider des joueurs)', () => {
  function starterSetup(players: Array<Record<string, unknown>>) {
    const playerUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
    const prisma = {
      player: {
        findMany: vi.fn(async () => players),
        update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          playerUpdates.push({ id: args.where.id, data: args.data });
          return args.data;
        }),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'created', ...data })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      team: { update: vi.fn(async () => ({})) },
    } as unknown as PrismaService;
    const service = new IngestionService(
      prisma,
      {} as never,
      {} as never,
      { get: vi.fn() } as unknown as ConfigService,
      ...providersFactices(),
      { add: vi.fn(), getJob: vi.fn() } as unknown as Queue,
    );
    return { service, playerUpdates };
  }
  const team = { id: 'team-a', gameId: 'lol', name: 'T1' } as never;

  it('complète photo/pays/rôle d’un joueur existant (Leaguepedia source de vérité)', async () => {
    const { service, playerUpdates } = starterSetup([
      { id: 'p1', name: 'Canna', teamId: 'team-a', role: 'Top', imageUrl: null, nationality: null, fieldSources: null, providerIds: null },
    ]);
    await service.applyStarterRoster(team, [
      { name: 'Canna', role: 'Top', imageUrl: 'https://lol.fandom.com/photo.png', nationality: 'KR' },
    ]);
    const update = playerUpdates.find((u) => u.id === 'p1');
    expect(update?.data).toMatchObject({
      imageUrl: 'https://lol.fandom.com/photo.png',
      nationality: 'KR',
      fieldSources: { imageUrl: 'leaguepedia', nationality: 'leaguepedia', role: 'leaguepedia' },
    });
    expect(update?.data).not.toHaveProperty('name');
  });

  it('pas d’update quand rien ne change', async () => {
    const { service, playerUpdates } = starterSetup([
      { id: 'p1', name: 'Canna', teamId: 'team-a', role: 'Top', imageUrl: 'https://x.png', nationality: 'KR', fieldSources: { role: 'leaguepedia' }, providerIds: null },
    ]);
    await service.applyStarterRoster(team, [
      { name: 'Canna', role: 'Top', imageUrl: 'https://x.png', nationality: 'KR' },
    ]);
    expect(playerUpdates).toHaveLength(0);
  });
});

describe('upsertTeam (précédence des champs)', () => {
  function teamSetup(existing: Record<string, unknown> | null) {
    const teamUpdates: Array<Record<string, unknown>> = [];
    const teamCreates: Array<Record<string, unknown>> = [];
    const queueAdds: Array<string> = [];
    const prisma = {
      team: {
        findUnique: vi.fn(async () => existing),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          teamUpdates.push(data);
          return { id: 'team-a', ...data };
        }),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          teamCreates.push(data);
          return { id: 'team-a', ...data };
        }),
      },
      competitionTeam: { upsert: vi.fn(async () => ({})) },
    } as unknown as PrismaService;
    const queue = {
      add: vi.fn(async (name: string) => {
        queueAdds.push(name);
      }),
      getJob: vi.fn(async () => undefined),
    } as unknown as Queue;
    const service = new IngestionService(
      prisma,
      {} as never,
      {} as never,
      { get: vi.fn() } as unknown as ConfigService,
      ...providersFactices(),
      queue,
    );
    return { service, teamUpdates, teamCreates, queueAdds };
  }
  const ref = { id: 10, name: 'Team Vitality', acronym: 'VIT', image_url: 'ps.png', location: 'FR' };

  it('l’update Pandascore n’écrase pas les champs possédés par un provider', async () => {
    const { service, teamUpdates } = teamSetup({
      id: 'team-a',
      fieldSources: { name: 'vlr', imageUrl: 'vlr' },
    });
    await service['upsertTeam']('cs2', 'comp-1', ref as never);
    expect(teamUpdates[0]).toEqual({ acronym: 'VIT', location: 'FR' });
  });

  it('une création d’équipe déclenche l’enrichissement provider', async () => {
    const { service, teamCreates, queueAdds } = teamSetup(null);
    await service['upsertTeam']('cs2', 'comp-1', ref as never);
    expect(teamCreates[0]).toMatchObject({ pandascoreId: 10, name: 'Team Vitality' });
    expect(queueAdds).toContain('enrich-team');
  });
});

describe('backfillTeamPlayers', () => {
  it('enqueue l’ingestion des derniers matchs finis sans stats des équipes', async () => {
    const add = vi.fn(async (_name?: string, _data?: unknown, _opts?: { jobId?: string }) => undefined);
    const prisma = {
      competition: {
        findUnique: vi.fn(async () => ({
          id: 'comp-1',
          gameId: 'cs2',
          name: 'Blast',
          teams: [{ teamId: 'team-a' }, { teamId: 'team-b' }],
        })),
      },
      match: {
        // team-a et team-b partagent m1 : dédupliqué à l'enqueue.
        findMany: vi.fn(async () => [{ id: 'm1' }]),
      },
    } as unknown as PrismaService;
    const service = new IngestionService(
      prisma,
      {} as never,
      {} as never,
      { get: vi.fn() } as unknown as ConfigService,
      ...providersFactices(),
      { add, getJob: vi.fn(async () => undefined) } as unknown as Queue,
    );
    const count = await service.backfillTeamPlayers('comp-1');
    expect(count).toBe(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][0]).toBe('ingest-stats');
  });
});
