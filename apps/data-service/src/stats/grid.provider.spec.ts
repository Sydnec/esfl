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
  // (kills/deaths présents : une game sans aucun compteur est traitée comme
  // non enregistrée par Grid et ignorée.)
  games: [
    {
      sequenceNumber: 1,
      finished: true,
      teams: [
        { name: 'Vitality', players: [{ name: 'ZywOo', firstKill: true, kills: 30, deaths: 18 }] },
      ],
    },
    {
      sequenceNumber: 2,
      finished: true,
      teams: [
        {
          name: 'Vitality',
          players: [
            { name: 'ZywOo', firstKill: true, kills: 25, deaths: 20 },
            { name: 'apEX', firstKill: false, kills: 15, deaths: 21 },
          ],
        },
      ],
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

  it('ignore les joueurs à agrégat nul (observateurs d’une game vide) et la game vide', () => {
    // Cas réel B8 vs BB : la game 3 Grid est intégralement à zéro et son
    // lineup contient des noms parasites absents des vraies games.
    const withGhosts: GridSeriesState = {
      finished: true,
      teams: [
        {
          name: 'Vitality',
          players: [
            { name: 'ZywOo', kills: 40, deaths: 30, killAssistsGiven: 10 },
            { name: 'Observateur1', kills: 0, deaths: 0, killAssistsGiven: 0 },
          ],
        },
        {
          name: 'NAVI',
          players: [{ name: 'Aleksib', kills: 25, deaths: 35, killAssistsGiven: 8 }],
        },
      ],
      games: [
        {
          sequenceNumber: 1,
          finished: true,
          map: { name: 'mirage' },
          teams: [
            { name: 'Vitality', players: [{ name: 'ZywOo', kills: 21, deaths: 16, firstKill: true }] },
            { name: 'NAVI', players: [{ name: 'Aleksib', kills: 12, deaths: 15 }] },
          ],
        },
        {
          // Game vide : personne n'a de kills/morts → non enregistrée.
          sequenceNumber: 2,
          finished: true,
          map: { name: 'dust2' },
          teams: [
            {
              name: 'Vitality',
              players: [
                { name: 'ZywOo', kills: 0, deaths: 0, firstKill: true },
                { name: 'Observateur1', kills: 0, deaths: 0 },
              ],
            },
          ],
        },
      ],
    };
    const lines = mapGridSeriesState(withGhosts, { name: 'Vitality' }, { name: 'NAVI' });
    expect(lines.map((line) => line.externalName).sort()).toEqual(['Aleksib', 'ZywOo']);
    const zywoo = lines.find((line) => line.externalName === 'ZywOo');
    // firstKill de la game vide non compté ; perMap sans la game vide.
    expect((zywoo?.normalized as { firstKills: number }).firstKills).toBe(1);
    const perMap = zywoo?.perMap as Array<{ position: number }>;
    expect(perMap.map((entry) => entry.position)).toEqual([1]);
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
