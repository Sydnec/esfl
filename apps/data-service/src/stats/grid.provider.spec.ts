import { describe, expect, it } from 'vitest';
import { GridSeriesState, mapGridGames, mapGridSeriesState } from './grid.provider';

const state: GridSeriesState = {
  finished: true,
  teams: [
    {
      name: 'Vitality',
      players: [
        {
          name: 'ZywOo',
          kills: 55,
          deaths: 38,
          killAssistsGiven: 12,
          objectives: [
            { type: 'plantBomb', completionCount: 4 },
            { type: 'defuseBomb', completionCount: 2 },
            { type: 'explodeBomb', completionCount: 1 },
          ],
        },
        { name: 'apEX', kills: 30, deaths: 41, killAssistsGiven: 18 },
      ],
    },
    {
      name: 'Équipe Mystère',
      players: [{ name: 'JoueurInconnu', kills: 20, deaths: 40, killAssistsGiven: 5 }],
    },
  ],
  // firstKill par manche : ZywOo ouvre 2 des 2 games → firstKills = 2.
  games: [
    {
      sequenceNumber: 1,
      finished: true,
      teams: [{ name: 'Vitality', players: [{ name: 'ZywOo', firstKill: true }] }],
    },
    {
      sequenceNumber: 2,
      finished: true,
      teams: [{ name: 'Vitality', players: [{ name: 'ZywOo', firstKill: true }, { name: 'apEX', firstKill: false }] }],
    },
  ],
};

describe('mapGridSeriesState', () => {
  it('mappe kills/deaths/assists avec le côté résolu par équipe', () => {
    const lines = mapGridSeriesState(state, { name: 'Vitality' }, { name: 'NAVI' });
    expect(lines).toHaveLength(3);
    const zywoo = lines.find((line) => line.externalName === 'ZywOo');
    expect(zywoo?.side).toBe('A');
    expect(zywoo?.normalized).toEqual({
      kills: 55,
      deaths: 38,
      assists: 12,
      adr: null,
      rating: null,
      plants: 4,
      defuses: 2,
      firstKills: 2,
    });
    // Équipe non résolue → side null (pas de création côté ingestion).
    expect(lines.find((line) => line.externalName === 'JoueurInconnu')?.side).toBeNull();
  });

  it('retourne vide sans équipes', () => {
    expect(mapGridSeriesState({ finished: true }, { name: 'Vitality' }, { name: 'NAVI' })).toHaveLength(0);
  });
});

describe('mapGridGames', () => {
  it('inclut la map en cours (started) mais pas les manches à venir du BO', () => {
    const live: GridSeriesState = {
      finished: false,
      games: [
        {
          sequenceNumber: 1,
          started: true,
          finished: true,
          map: { name: 'dust2' },
          teams: [
            { name: 'Vitality', score: 13 },
            { name: 'NAVI', score: 9 },
          ],
        },
        {
          sequenceNumber: 2,
          started: true,
          finished: false,
          map: { name: 'mirage' },
          teams: [
            { name: 'Vitality', score: 3 },
            { name: 'NAVI', score: 5 },
          ],
        },
        { sequenceNumber: 3, started: false, finished: false, map: null, teams: [] },
      ],
    };
    expect(mapGridGames(live, { name: 'Vitality' }, { name: 'NAVI' })).toEqual([
      { position: 1, map: 'dust2', scoreA: 13, scoreB: 9 },
      { position: 2, map: 'mirage', scoreA: 3, scoreB: 5 },
    ]);
  });
});
