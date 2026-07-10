import { describe, expect, it } from 'vitest';
import { findOctaneMatch, mapOctaneMatch, OctaneMatch } from './octane.provider';

const fixture: OctaneMatch = {
  _id: 'abc',
  date: '2026-07-07T18:00:00Z',
  blue: {
    team: { team: { name: 'Team BDS' } },
    players: [
      {
        player: { tag: 'M0nkey M00n' },
        stats: { core: { goals: 3, assists: 1, saves: 4, shots: 7, score: 780 } },
      },
      {
        player: { tag: 'JoueurInconnu' },
        stats: { core: { goals: 1, assists: 0, saves: 2, shots: 3, score: 400 } },
      },
    ],
  },
  orange: {
    team: { team: { name: 'Karmine Corp' } },
    players: [
      {
        player: { tag: 'ExoTiiK' },
        stats: { core: { goals: 2, assists: 2, saves: 1, shots: 5, score: 610 } },
      },
    ],
  },
};

describe('findOctaneMatch', () => {
  it('retrouve le match par noms d’équipes, ordre indifférent', () => {
    expect(findOctaneMatch([fixture], 'Karmine Corp', 'Team BDS')).toBe(fixture);
    expect(findOctaneMatch([fixture], 'BDS', 'Karmine Corp')).toBe(fixture);
    expect(findOctaneMatch([fixture], 'Vitality', 'Karmine Corp')).toBeNull();
  });
});

describe('mapOctaneMatch', () => {
  it('mappe les stats cœur avec le côté résolu par équipe', () => {
    const lines = mapOctaneMatch(fixture, 'Team BDS', 'Karmine Corp');
    expect(lines).toHaveLength(3);
    const bds = lines.find((line) => line.externalName === 'M0nkey M00n');
    expect(bds?.side).toBe('A');
    expect(bds?.normalized).toEqual({ goals: 3, assists: 1, saves: 4, shots: 7, score: 780 });
    const kc = lines.find((line) => line.externalName === 'ExoTiiK');
    expect(kc?.side).toBe('B');
    expect(kc?.normalized).toEqual({ goals: 2, assists: 2, saves: 1, shots: 5, score: 610 });
  });
});
