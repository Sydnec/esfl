import { describe, expect, it, vi } from 'vitest';
import type { Match, Team } from '../../generated/client';
import type { PrismaService } from '../prisma.service';
import type { GridStatsProvider } from './grid.provider';
import type { LeaguepediaStatsProvider } from './leaguepedia.provider';
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
  const playerUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const playerUpdateManys: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  let nextId = 1;
  const prisma = {
    player: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: `nouveau-${nextId++}`, ...data };
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        playerUpdates.push({ id: args.where.id, data: args.data });
        return args.data;
      }),
      updateMany: vi.fn(
        async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          playerUpdateManys.push(args);
          return { count: 0 };
        },
      ),
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
  return {
    prisma: prisma as unknown as PrismaService,
    created,
    upserts,
    matchUpdates,
    teamUpdates,
    playerUpdates,
    playerUpdateManys,
  };
}

function service(prisma: PrismaService) {
  const queue = { add: vi.fn() };
  const ingestionQueue = { add: vi.fn(), getJob: vi.fn(async () => undefined) };
  const liveEvents = { emitMatchUpdated: vi.fn() };
  return new StatsIngestionService(
    prisma,
    queue as never,
    ingestionQueue as never,
    liveEvents as never,
    { gameId: 'cs2' } as GridStatsProvider,
    { gameId: 'valorant' } as VlrStatsProvider,
    { gameId: 'lol' } as LeaguepediaStatsProvider,
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

function context(
  players: Array<{ id: string; name: string; teamId: string }>,
  teams?: { teamA: Team; teamB: Team },
): MatchContext {
  // Équipes fraîches possibles : learnSourceAliases mute team.aliases, il ne
  // faut pas partager les objets entre tests d'apprentissage d'alias.
  return {
    teamA: teams?.teamA ?? teamA,
    teamB: teams?.teamB ?? teamB,
    players: players as MatchContext['players'],
  };
}

/** Paire d'équipes fraîches (ids team-a/team-b) pour les tests d'alias. */
function freshTeams() {
  return {
    teamA: { id: 'team-a', name: 'Vitality' } as Team,
    teamB: { id: 'team-b', name: 'NAVI' } as Team,
  };
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
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      gameId: 'cs2',
      name: 'NewComer',
      teamId: 'team-a',
      source: 'grid',
      // Le pseudo posé par le provider est possédé d'entrée.
      fieldSources: { name: 'grid' },
    });
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
    const ctx = context(
      [
        { id: 'p1', name: 'ZywOo', teamId: 'team-a' }, // Vitality
        { id: 'p2', name: 'Aleksib', teamId: 'team-b' }, // NAVI
      ],
      freshTeams(),
    );
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

  it('apprend l’alias via le côté résolu par le provider même quand les joueurs sont nouveaux', async () => {
    const { prisma, matchUpdates, teamUpdates } = fakePrisma();
    const ingestion = service(prisma);
    // Aucun joueur en roster : le mapping s'appuie sur le côté résolu par le provider.
    await ingestion['persistResult'](match, context([], freshTeams()), 'vlr', {
      lines: [
        { externalName: 'NewA', side: 'A', teamName: 'Xi Lai', raw: {}, normalized: { kills: 1 } },
        { externalName: 'NewB', side: 'B', teamName: 'Titan', raw: {}, normalized: { kills: 1 } },
      ],
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
    const summary = matchUpdates.find((data) => 'gamesSummary' in data);
    expect(summary?.gamesSummary).toEqual([{ position: 1, map: 'Ascent', scoreA: 13, scoreB: 7 }]);
    expect(teamUpdates.map((u) => u.id).sort()).toEqual(['team-a', 'team-b']);
  });

  it('snapshotte pseudo/rôle/côté sur la ligne et les équipes sur le match', async () => {
    const { prisma, upserts, matchUpdates } = fakePrisma();
    const ingestion = service(prisma);
    const lolMatch = { ...match, gameId: 'lol' } as Match;
    const ctx = context([{ id: 'p1', name: 'Faker', teamId: 'team-a', role: 'Mid' } as never]);
    await ingestion['persistResult'](lolMatch, ctx, 'leaguepedia', {
      lines: [{ ...line('Faker', 'A'), role: 'Mid' }],
    });
    expect(upserts[0].create).toMatchObject({
      playerName: 'Faker',
      role: 'Mid',
      teamSide: 'A',
    });
    // Update aussi (ré-ingestion) : le snapshot est rafraîchi.
    expect(upserts[0].update).toMatchObject({ playerName: 'Faker', role: 'Mid', teamSide: 'A' });
    const snapshot = matchUpdates.find((data) => 'teamASnapshot' in data);
    expect(snapshot?.teamASnapshot).toEqual({ name: 'Vitality', acronym: undefined });
    expect(snapshot?.teamBSnapshot).toEqual({ name: 'NAVI', acronym: undefined });
  });

  it('met à jour le dernier rôle connu quand le rôle joué change', async () => {
    const { prisma, playerUpdates } = fakePrisma();
    const ingestion = service(prisma);
    const lolMatch = { ...match, gameId: 'lol' } as Match;
    const ctx = context([{ id: 'p1', name: 'Player', teamId: 'team-a', role: 'Mid' } as never]);
    await ingestion['persistResult'](lolMatch, ctx, 'leaguepedia', {
      lines: [{ ...line('Player', 'A'), role: 'Bot' }],
    });
    const roleUpdate = playerUpdates.find((u) => u.id === 'p1' && 'role' in u.data);
    expect(roleUpdate?.data).toMatchObject({
      role: 'Bot',
      fieldSources: { role: 'leaguepedia' },
    });
  });

  it('ne touche pas au rôle de la fiche quand le rôle joué est inchangé', async () => {
    const { prisma, playerUpdates } = fakePrisma();
    const ingestion = service(prisma);
    const lolMatch = { ...match, gameId: 'lol' } as Match;
    const ctx = context([{ id: 'p1', name: 'Player', teamId: 'team-a', role: 'Mid' } as never]);
    await ingestion['persistResult'](lolMatch, ctx, 'leaguepedia', {
      lines: [{ ...line('Player', 'A'), role: 'Mid' }],
    });
    expect(playerUpdates.filter((u) => 'role' in u.data)).toHaveLength(0);
  });
});

describe('garde « les joueurs collent »', () => {
  it('rejette des stats où aucun joueur connu du roster ne se résout', async () => {
    const { prisma, upserts } = fakePrisma();
    const ingestion = service(prisma);
    // team-a a un roster connu ; la source ne renvoie que des inconnus de son
    // côté → alias volé ou mauvaise page : rien ne doit être enregistré.
    const ctx = context([
      { id: 'p1', name: 'Alpha', teamId: 'team-a' },
      { id: 'p2', name: 'Bravo', teamId: 'team-a' },
      { id: 'p3', name: 'Charlie', teamId: 'team-a' },
    ]);
    await expect(
      ingestion['persistResult'](match, ctx, 'grid', {
        lines: [line('Inconnu1', 'A'), line('Inconnu2', 'A'), line('Inconnu3', 'A')],
      }),
    ).rejects.toThrow(/rattachement suspect/);
    expect(upserts).toHaveLength(0);
  });

  it('laisse passer quand au moins un joueur connu se résout', async () => {
    const { prisma, upserts } = fakePrisma();
    const ingestion = service(prisma);
    const ctx = context([
      { id: 'p1', name: 'Alpha', teamId: 'team-a' },
      { id: 'p2', name: 'Bravo', teamId: 'team-a' },
      { id: 'p3', name: 'Charlie', teamId: 'team-a' },
    ]);
    await ingestion['persistResult'](match, ctx, 'grid', {
      lines: [line('Alpha', 'A'), line('Remplaçant', 'A')],
    });
    expect(upserts).toHaveLength(2);
  });
});

describe('applyMatchRoster', () => {
  const playedAt = new Date('2026-07-10T18:00:00Z');
  const datedMatch = { ...match, beginAt: playedAt } as Match;
  const lineup = (names: string[], side: 'A' | 'B') =>
    names.map((name) => line(name, side));

  it('le lineup du match devient le roster courant (teamId + active)', async () => {
    const { prisma, playerUpdateManys, teamUpdates } = fakePrisma();
    const ingestion = service(prisma);
    // p-transfert appartient encore à team-b : le match le rapatrie côté A.
    const ctx = context([
      { id: 'p1', name: 'Alpha', teamId: 'team-a' },
      { id: 'p2', name: 'Bravo', teamId: 'team-a' },
      { id: 'p3', name: 'Charlie', teamId: 'team-b' },
    ]);
    await ingestion['persistResult'](datedMatch, ctx, 'grid', {
      lines: lineup(['Alpha', 'Bravo', 'Charlie'], 'A'),
    });
    const activation = playerUpdateManys.find(
      (u) => (u.data as { teamId?: string }).teamId === 'team-a',
    );
    expect(activation?.where).toEqual({ id: { in: ['p1', 'p2', 'p3'] } });
    expect(activation?.data).toEqual({ teamId: 'team-a', active: true });
    const deactivation = playerUpdateManys.find((u) => u.data.active === false);
    expect(deactivation?.where).toMatchObject({ teamId: 'team-a' });
    expect(
      teamUpdates.find((u) => u.id === 'team-a' && 'rosterSyncedAt' in u.data)?.data
        .rosterSyncedAt,
    ).toEqual(playedAt);
  });

  it('ignore une page partielle (moins de 3 joueurs résolus)', async () => {
    const { prisma, playerUpdateManys } = fakePrisma();
    const ingestion = service(prisma);
    const ctx = context([
      { id: 'p1', name: 'Alpha', teamId: 'team-a' },
      { id: 'p2', name: 'Bravo', teamId: 'team-a' },
    ]);
    await ingestion['persistResult'](datedMatch, ctx, 'grid', {
      lines: lineup(['Alpha', 'Bravo'], 'A'),
    });
    expect(playerUpdateManys).toHaveLength(0);
  });

  it('un backfill de vieux match ne régresse pas un roster plus récent', async () => {
    const { prisma, playerUpdateManys } = fakePrisma();
    const ingestion = service(prisma);
    const teams = {
      teamA: { id: 'team-a', name: 'Vitality', rosterSyncedAt: new Date('2026-07-12') } as Team,
      teamB: { id: 'team-b', name: 'NAVI' } as Team,
    };
    const ctx = context(
      [
        { id: 'p1', name: 'Alpha', teamId: 'team-a' },
        { id: 'p2', name: 'Bravo', teamId: 'team-a' },
        { id: 'p3', name: 'Charlie', teamId: 'team-a' },
      ],
      teams,
    );
    await ingestion['persistResult'](datedMatch, ctx, 'grid', {
      lines: lineup(['Alpha', 'Bravo', 'Charlie'], 'A'),
    });
    expect(playerUpdateManys).toHaveLength(0);
  });
});
