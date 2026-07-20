import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/client';
import type { PrismaService } from '../prisma.service';
import { createPlayerSafely } from './player-create';

/**
 * Création de fiche joueur tolérante à la course : quand l'index unique
 * `players_game_team_name_key` rejette la seconde création concurrente, on
 * doit récupérer la fiche gagnante plutôt que de laisser remonter l'erreur.
 */

const conflict = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

const data: Prisma.PlayerUncheckedCreateInput = {
  gameId: 'cs2',
  name: 'ZywOo',
  teamId: 'team-a',
  source: 'grid',
};

describe('createPlayerSafely', () => {
  it('renvoie la fiche créée quand il n’y a pas de course', async () => {
    const prisma = {
      player: { create: vi.fn(async () => ({ id: 'p1', name: 'ZywOo' })) },
      $queryRaw: vi.fn(),
    } as unknown as PrismaService;
    const player = await createPlayerSafely(prisma, data);
    expect(player).toMatchObject({ id: 'p1' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('course perdue : relit la fiche gagnante au lieu de lever', async () => {
    const prisma = {
      player: {
        create: vi.fn(async () => {
          throw conflict();
        }),
        // La récupération relit la fiche gagnante par id (objet Prisma
        // camelCase complet), pas via le SELECT brut.
        findUnique: vi.fn(async () => ({ id: 'gagnante', name: 'ZywOo', teamId: 'team-a' })),
      },
      $queryRaw: vi.fn(async () => [{ id: 'gagnante' }]),
    } as unknown as PrismaService;
    const player = await createPlayerSafely(prisma, data);
    expect(player).toMatchObject({ id: 'gagnante', teamId: 'team-a' });
  });

  it('conflit sans fiche retrouvée : l’erreur remonte (pas de fiche inventée)', async () => {
    const prisma = {
      player: {
        create: vi.fn(async () => {
          throw conflict();
        }),
      },
      $queryRaw: vi.fn(async () => []),
    } as unknown as PrismaService;
    await expect(createPlayerSafely(prisma, data)).rejects.toThrow();
  });

  it('une erreur autre qu’un conflit d’unicité remonte telle quelle', async () => {
    const prisma = {
      player: {
        create: vi.fn(async () => {
          throw new Error('connexion perdue');
        }),
      },
      $queryRaw: vi.fn(),
    } as unknown as PrismaService;
    await expect(createPlayerSafely(prisma, data)).rejects.toThrow('connexion perdue');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
