import { describe, expect, it } from 'vitest';
import {
  BallchasingReplayDetail,
  BallchasingReplaySummary,
  findBallchasingReplays,
  mapBallchasingGames,
  mapBallchasingReplays,
} from './ballchasing.provider';

const game1: BallchasingReplayDetail = {
  id: 'r1',
  status: 'ok',
  map_name: 'DFH Stadium',
  blue: {
    name: 'Team BDS',
    goals: 3,
    players: [
      { name: 'M0nkey M00n', stats: { core: { goals: 2, assists: 1, saves: 3, shots: 5, score: 720 } } },
      { name: 'Seikoo', stats: { core: { goals: 1, assists: 1, saves: 1, shots: 2, score: 450 } } },
    ],
  },
  orange: {
    name: 'Karmine Corp',
    goals: 1,
    players: [
      { name: 'ExoTiiK', stats: { core: { goals: 1, assists: 0, saves: 2, shots: 4, score: 510 } } },
    ],
  },
};

// Manche 2 : couleurs inversées (BDS passe côté orange).
const game2: BallchasingReplayDetail = {
  id: 'r2',
  status: 'ok',
  map_name: 'Mannfield',
  blue: {
    name: 'Karmine Corp',
    goals: 2,
    players: [
      { name: 'ExoTiiK', stats: { core: { goals: 2, assists: 1, saves: 0, shots: 3, score: 630 } } },
    ],
  },
  orange: {
    name: 'Team BDS',
    goals: 4,
    players: [
      { name: 'M0nkey M00n', stats: { core: { goals: 3, assists: 0, saves: 2, shots: 6, score: 810 } } },
      { name: 'Seikoo', stats: { core: { goals: 1, assists: 2, saves: 1, shots: 1, score: 380 } } },
    ],
  },
};

describe('findBallchasingReplays', () => {
  it('filtre par les deux noms d’équipes, ordre et couleur indifférents', () => {
    const replays: BallchasingReplaySummary[] = [
      { id: 'r1', blue: { name: 'Team BDS' }, orange: { name: 'Karmine Corp' } },
      { id: 'r2', blue: { name: 'Karmine Corp' }, orange: { name: 'Team BDS' } },
      { id: 'autre', blue: { name: 'Vitality' }, orange: { name: 'Karmine Corp' } },
      { id: 'ranked', blue: {}, orange: {} },
    ];
    const found = findBallchasingReplays(replays, 'Karmine Corp', 'Team BDS');
    expect(found.map((replay) => replay.id)).toEqual(['r1', 'r2']);
  });
});

describe('mapBallchasingReplays', () => {
  it('somme les manches par joueur, côté résolu replay par replay', () => {
    const lines = mapBallchasingReplays([game1, game2], 'Team BDS', 'Karmine Corp');
    expect(lines).toHaveLength(3);

    const mm = lines.find((line) => line.externalName === 'M0nkey M00n');
    expect(mm?.side).toBe('A');
    expect(mm?.normalized).toEqual({ goals: 5, assists: 1, saves: 5, shots: 11, score: 1530 });

    const exo = lines.find((line) => line.externalName === 'ExoTiiK');
    expect(exo?.side).toBe('B');
    expect(exo?.normalized).toEqual({ goals: 3, assists: 1, saves: 2, shots: 7, score: 1140 });
  });

  it('ignore les joueurs sans pseudo et tolère les stats manquantes', () => {
    const partial: BallchasingReplayDetail = {
      blue: { name: 'Team BDS', players: [{ name: 'Seikoo' }, {}] },
      orange: { name: 'Karmine Corp', players: [] },
    };
    const lines = mapBallchasingReplays([partial], 'Team BDS', 'Karmine Corp');
    expect(lines).toHaveLength(1);
    expect(lines[0].normalized).toEqual({ goals: 0, assists: 0, saves: 0, shots: 0, score: 0 });
  });
});

describe('mapBallchasingGames', () => {
  it('projette chaque replay en manche, score ramené au côté A/B', () => {
    expect(mapBallchasingGames([game1, game2], 'Team BDS')).toEqual([
      { position: 1, map: 'DFH Stadium', scoreA: 3, scoreB: 1 },
      { position: 2, map: 'Mannfield', scoreA: 4, scoreB: 2 },
    ]);
  });
});
