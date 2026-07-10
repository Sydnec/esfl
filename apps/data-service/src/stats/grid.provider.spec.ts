import { describe, expect, it } from 'vitest';
import { GridSeriesState, mapGridSeriesState } from './grid.provider';

const state: GridSeriesState = {
  finished: true,
  teams: [
    {
      name: 'Vitality',
      players: [
        { name: 'ZywOo', kills: 55, deaths: 38, killAssistsGiven: 12 },
        { name: 'apEX', kills: 30, deaths: 41, killAssistsGiven: 18 },
      ],
    },
    {
      name: 'Équipe Mystère',
      players: [{ name: 'JoueurInconnu', kills: 20, deaths: 40, killAssistsGiven: 5 }],
    },
  ],
};

describe('mapGridSeriesState', () => {
  it('mappe kills/deaths/assists avec le côté résolu par équipe', () => {
    const lines = mapGridSeriesState(state, 'Vitality', 'NAVI');
    expect(lines).toHaveLength(3);
    const zywoo = lines.find((line) => line.externalName === 'ZywOo');
    expect(zywoo?.side).toBe('A');
    expect(zywoo?.normalized).toEqual({
      kills: 55,
      deaths: 38,
      assists: 12,
      adr: null,
      rating: null,
    });
    // Équipe non résolue → side null (pas de création côté ingestion).
    expect(lines.find((line) => line.externalName === 'JoueurInconnu')?.side).toBeNull();
  });

  it('retourne vide sans équipes', () => {
    expect(mapGridSeriesState({ finished: true }, 'Vitality', 'NAVI')).toHaveLength(0);
  });
});
