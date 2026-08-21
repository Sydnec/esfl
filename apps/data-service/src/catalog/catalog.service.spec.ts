import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma.service';
import { CatalogService, clustersParPseudo, identiteCivile } from './catalog.service';

/**
 * Clés d'identité de la fusion des doublons : deux fiches ne doivent être
 * réunies que si elles désignent vraiment la même personne.
 */
describe('identiteCivile', () => {
  it('distingue deux découpages qu’une concaténation brute confondait', () => {
    expect(identiteCivile('Kim', 'Minseong')).not.toBe(identiteCivile('Kimm', 'Inseong'));
  });

  it('absorbe casse, accents et ponctuation', () => {
    expect(identiteCivile('Rémy', "O'Brien")).toBe(identiteCivile('remy', 'obrien'));
  });

  it('exige les deux parties : un prénom seul est trop partagé', () => {
    expect(identiteCivile('Kim', null)).toBeNull();
    expect(identiteCivile('  ', 'Minseong')).toBeNull();
  });
});

describe('clustersParPseudo', () => {
  it('réunit deux extrêmes reliés par un pseudo intermédiaire', () => {
    const groupes = clustersParPseudo([{ name: 'Caliste' }, { name: 'Calist' }]);
    expect(groupes).toHaveLength(1);
  });

  it('sépare deux pseudos sans rapport', () => {
    expect(clustersParPseudo([{ name: 'Caliste' }, { name: 'Zywoo' }])).toHaveLength(2);
  });

  it('rend le même découpage quel que soit l’ordre d’arrivée', () => {
    const fiches = [{ name: 'Kuruma' }, { name: 'Kurumaa' }, { name: 'Kurumaaa' }];
    const direct = clustersParPseudo(fiches);
    // Ordre qui plaçait autrefois les extrêmes avant le pont : le troisième
    // restait isolé alors qu'il appartient au même groupe.
    const inverse = clustersParPseudo([fiches[0], fiches[2], fiches[1]]);
    expect(inverse.map((groupe) => groupe.length).sort()).toEqual(
      direct.map((groupe) => groupe.length).sort(),
    );
  });
});

/**
 * Complétude d'une journée = base du gel des scores. Un match fini aux stats
 * INCOHÉRENTES ne doit pas la rendre complète, sinon la journée gèlerait sur des
 * données partielles avant que la relance ne les corrige.
 */
describe('dayCompleteness — le gel attend des stats cohérentes', () => {
  const beginAt = new Date('2026-07-22T18:00:00Z'); // 22/07 en heure de Paris
  const summaryCs2 = [
    { position: 1, scoreA: 13, scoreB: 4, winner: 'A' },
    { position: 2, scoreA: 7, scoreB: 13, winner: 'B' },
    { position: 3, winner: 'B' },
  ];

  function serviceAvecMatch(
    perMapParPosition: Array<{ position: number; rounds?: number | null }>,
  ) {
    const stats = Array.from({ length: 10 }, () => ({
      perMap: perMapParPosition.map((m) => ({ position: m.position, rounds: m.rounds ?? null })),
    }));
    const match = {
      id: 'm1',
      gameId: 'cs2',
      status: 'finished',
      forfeit: false,
      beginAt,
      scheduledAt: beginAt,
      statsFailureKind: null,
      teamAId: 'a',
      teamBId: 'b',
      gamesSummary: summaryCs2,
      _count: { stats: stats.length },
      stats,
    };
    const prisma = { match: { findMany: vi.fn(async () => [match]) } };
    return new CatalogService(prisma as unknown as PrismaService);
  }

  it('journée NON complète tant qu’un match a des stats incohérentes (map absente)', async () => {
    const service = serviceAvecMatch([
      { position: 1, rounds: 17 },
      { position: 2, rounds: 20 },
    ]); // position 3 absente
    const result = await service.dayCompleteness('2026-07-22');
    expect(result.incoherentCount).toBe(1);
    expect(result.complete).toBe(false);
  });

  it('journée complète une fois les stats cohérentes', async () => {
    const service = serviceAvecMatch([
      { position: 1, rounds: 17 },
      { position: 2, rounds: 20 },
      { position: 3, rounds: null },
    ]);
    const result = await service.dayCompleteness('2026-07-22');
    expect(result.incoherentCount).toBe(0);
    expect(result.complete).toBe(true);
  });
});

/**
 * Le rattrapage des notes côté scoring interroge cette liste : il ne veut que
 * les matchs TERMINÉS d'une fenêtre récente, pas tout l'historique (un match en
 * cours est re-noté à chaque passe de stats live, puis au coup de sifflet).
 */
describe('distinctStatsMatchIds', () => {
  function service() {
    const filtres: unknown[] = [];
    const prisma = {
      playerMatchStats: {
        findMany: vi.fn(async ({ where }: { where: unknown }) => {
          filtres.push(where);
          return [{ matchId: 'm1' }, { matchId: 'm2' }];
        }),
      },
    };
    return { catalog: new CatalogService(prisma as unknown as PrismaService), filtres };
  }

  it('sans `since` : tous les matchs à stats, sans filtre (recalcul complet)', async () => {
    const { catalog, filtres } = service();
    expect(await catalog.distinctStatsMatchIds()).toEqual(['m1', 'm2']);
    expect(filtres.at(0)).toEqual({});
  });

  it('avec `since` : matchs terminés commencés depuis cette date', async () => {
    const { catalog, filtres } = service();
    const since = new Date('2026-07-01T00:00:00Z');
    await catalog.distinctStatsMatchIds(since);
    expect(filtres.at(0)).toEqual({
      match: {
        status: 'finished',
        OR: [{ beginAt: { gte: since } }, { beginAt: null, scheduledAt: { gte: since } }],
      },
    });
  });
});
