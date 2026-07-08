import { describe, expect, it } from 'vitest';
import type { Player } from '../../generated/client';
import { GridSeriesState, mapGridSeriesState } from './grid.provider';

const players = [
  { id: 'p1', name: 'ZywOo' },
  { id: 'p2', name: 'apEX' },
] as Player[];

const state: GridSeriesState = {
  finished: true,
  teams: [
    {
      name: 'Vitality',
      players: [
        { name: 'ZywOo', kills: 55, deaths: 38, killAssistsGiven: 12 },
        { name: 'apEX', kills: 30, deaths: 41, killAssistsGiven: 18 },
        { name: 'JoueurInconnu', kills: 20, deaths: 40, killAssistsGiven: 5 },
      ],
    },
  ],
};

describe('mapGridSeriesState', () => {
  it('mappe kills/deaths/assists et laisse adr/rating null', () => {
    const lines = mapGridSeriesState(state, players);
    expect(lines).toHaveLength(2);
    const zywoo = lines.find((line) => line.playerId === 'p1');
    expect(zywoo?.normalized).toEqual({
      kills: 55,
      deaths: 38,
      assists: 12,
      adr: null,
      rating: null,
    });
  });

  it('retourne vide sans équipes', () => {
    expect(mapGridSeriesState({ finished: true }, players)).toHaveLength(0);
  });
});
