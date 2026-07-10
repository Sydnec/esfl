import { describe, expect, it } from 'vitest';
import { mergeGamesSummary } from './games-summary';

describe('mergeGamesSummary', () => {
  const enriched = [
    { position: 1, winner: 'A', map: 'Haven', scoreA: 13, scoreB: 7 },
    { position: 2, winner: 'B', map: 'Bind', scoreA: 10, scoreB: 13 },
  ];

  it('un sync Pandascore ne perd pas l’enrichissement provider', () => {
    const merged = mergeGamesSummary(enriched, [
      { position: 1, winner: 'A', lengthSec: 2400 },
      { position: 2, winner: 'B', lengthSec: 2100 },
    ]);
    expect(merged[0]).toMatchObject({ map: 'Haven', scoreA: 13, scoreB: 7, lengthSec: 2400 });
    expect(merged[1]).toMatchObject({ map: 'Bind', winner: 'B', lengthSec: 2100 });
  });

  it('les champs nuls de la source entrante ne masquent rien', () => {
    const merged = mergeGamesSummary(enriched, [{ position: 1, winner: null, lengthSec: null }]);
    expect(merged[0]).toMatchObject({ winner: 'A', map: 'Haven' });
  });

  it('union des positions, triée', () => {
    const merged = mergeGamesSummary([{ position: 2, winner: 'B' }], [
      { position: 1, winner: 'A' },
      { position: 3, winner: null },
    ]);
    expect(merged.map((entry) => entry.position)).toEqual([1, 2, 3]);
  });

  it('gamesSummary inexistant → liste entrante', () => {
    const merged = mergeGamesSummary(null, [{ position: 1, winner: 'A' }]);
    expect(merged).toEqual([{ position: 1, winner: 'A' }]);
  });
});
