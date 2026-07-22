import { describe, expect, it } from 'vitest';
import { evaluerCoherence } from './coherence';

/** Fabrique `n` lignes joueur couvrant les positions données, avec rounds optionnels. */
function stats(maps: Array<{ position: number; rounds?: number | null }>, joueurs: number) {
  return Array.from({ length: joueurs }, () => ({
    perMap: maps.map((m) => ({ position: m.position, rounds: m.rounds ?? null })),
  }));
}

const summaryCs2 = [
  { position: 1, scoreA: 13, scoreB: 4, winner: 'A' },
  { position: 2, scoreA: 7, scoreB: 13, winner: 'B' },
  { position: 3, winner: 'B' }, // décideur joué mais non chiffré
];

describe('evaluerCoherence', () => {
  it('signale une map jouée absente des stats (le cas de production)', () => {
    const result = evaluerCoherence(
      { gameId: 'cs2', gamesSummary: summaryCs2 },
      stats(
        [
          { position: 1, rounds: 17 },
          { position: 2, rounds: 20 },
        ],
        10,
      ),
    );
    expect(result.coherent).toBe(false);
    expect(result.raison).toMatch(/3 absente/);
  });

  it('tolère un roster partiel (pas de relance sans fin sur un joueur manquant)', () => {
    const result = evaluerCoherence(
      { gameId: 'cs2', gamesSummary: [{ position: 1, scoreA: 13, scoreB: 11, winner: 'A' }] },
      stats([{ position: 1, rounds: 24 }], 8),
    );
    expect(result.coherent).toBe(true);
  });

  it('signale un compte de manches tronqué (snapshot figé en cours de map)', () => {
    const result = evaluerCoherence(
      { gameId: 'cs2', gamesSummary: [{ position: 1, scoreA: 13, scoreB: 4, winner: 'A' }] },
      stats([{ position: 1, rounds: 10 }], 10),
    );
    expect(result.coherent).toBe(false);
    expect(result.raison).toMatch(/manches/);
  });

  it('tolère un écart de manches de 1 (arrondi damage/adr)', () => {
    const result = evaluerCoherence(
      { gameId: 'cs2', gamesSummary: [{ position: 1, scoreA: 13, scoreB: 4, winner: 'A' }] },
      stats([{ position: 1, rounds: 16 }], 10),
    );
    expect(result.coherent).toBe(true);
  });

  it('accepte un match CS2 complet et chiffré', () => {
    const result = evaluerCoherence(
      { gameId: 'cs2', gamesSummary: summaryCs2 },
      stats(
        [
          { position: 1, rounds: 17 },
          { position: 2, rounds: 20 },
          { position: 3, rounds: null }, // décideur : rounds non vérifiables mais couvert
        ],
        10,
      ),
    );
    expect(result.coherent).toBe(true);
  });

  it('Valorant : couverture seule, ignore les rounds', () => {
    const summary = [
      { position: 1, scoreA: 15, scoreB: 13, winner: 'A' },
      { position: 2, scoreA: 13, scoreB: 9, winner: 'A' },
    ];
    const result = evaluerCoherence(
      { gameId: 'valorant', gamesSummary: summary },
      // rounds absents (VLR ne les dérive pas) : ne doit pas déclencher le niveau 2
      stats([{ position: 1 }, { position: 2 }], 10),
    );
    expect(result.coherent).toBe(true);
  });

  it('LoL : couverture seule (pas de manches)', () => {
    const summary = [
      { position: 1, scoreA: 19, scoreB: 21, winner: 'B' },
      { position: 2, scoreA: 16, scoreB: 8, winner: 'A' },
    ];
    const complet = evaluerCoherence(
      { gameId: 'lol', gamesSummary: summary },
      stats([{ position: 1 }, { position: 2 }], 10),
    );
    expect(complet.coherent).toBe(true);
    const manquant = evaluerCoherence(
      { gameId: 'lol', gamesSummary: summary },
      stats([{ position: 1 }], 10),
    );
    expect(manquant.coherent).toBe(false);
  });

  it('structure inconnue (gamesSummary vide) : ne bloque pas', () => {
    expect(evaluerCoherence({ gameId: 'cs2', gamesSummary: [] }, []).coherent).toBe(true);
    expect(evaluerCoherence({ gameId: 'cs2', gamesSummary: null }, []).coherent).toBe(true);
  });
});
