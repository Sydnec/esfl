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
    const found = findBallchasingReplays(replays, { name: 'Karmine Corp' }, { name: 'Team BDS' });
    expect(found.map((replay) => replay.id)).toEqual(['r1', 'r2']);
  });

  it('déduplique les uploads multiples d’une même manche (map + scores + départ < 2 min)', () => {
    // Même manche vue par deux uploaders : fuseaux différents, 1 s d'écart.
    const replays: BallchasingReplaySummary[] = [
      {
        id: 'upload-arbitre',
        date: '2026-07-11T11:57:26-05:00',
        map_name: 'Mannfield (Night)',
        blue: { name: 'Team BDS', goals: 2 },
        orange: { name: 'Karmine Corp' },
      },
      {
        id: 'upload-joueur',
        date: '2026-07-11T17:57:25+01:00',
        map_name: 'Mannfield (Night)',
        blue: { name: 'Team BDS', goals: 2 },
        orange: { name: 'Karmine Corp', goals: 0 },
      },
      {
        id: 'manche-suivante',
        date: '2026-07-11T18:05:23+01:00',
        map_name: 'Mannfield (Night)',
        blue: { name: 'Team BDS', goals: 2 },
        orange: { name: 'Karmine Corp' },
      },
    ];
    const found = findBallchasingReplays(replays, { name: 'Team BDS' }, { name: 'Karmine Corp' });
    // Tri chronologique : l'upload du joueur (16:57:25Z) précède celui de
    // l'arbitre (16:57:26Z) d'une seconde, c'est lui qui est conservé.
    expect(found.map((replay) => replay.id)).toEqual(['upload-joueur', 'manche-suivante']);
  });
});

describe('mapBallchasingReplays', () => {
  it('somme les manches par joueur, côté résolu replay par replay', () => {
    const lines = mapBallchasingReplays([game1, game2], { name: 'Team BDS' }, { name: 'Karmine Corp' });
    expect(lines).toHaveLength(3);

    const mm = lines.find((line) => line.externalName === 'M0nkey M00n');
    expect(mm?.side).toBe('A');
    expect(mm?.normalized).toEqual({
      goals: 5,
      assists: 1,
      saves: 5,
      shots: 11,
      score: 1530,
      demosInflicted: 0,
      boostBpm: 0,
      shootingPct: 0.455,
      bcpm: 0,
      demosTaken: 0,
    });

    const exo = lines.find((line) => line.externalName === 'ExoTiiK');
    expect(exo?.side).toBe('B');
    expect(exo?.normalized).toEqual({
      goals: 3,
      assists: 1,
      saves: 2,
      shots: 7,
      score: 1140,
      demosInflicted: 0,
      boostBpm: 0,
      shootingPct: 0.429,
      bcpm: 0,
      demosTaken: 0,
    });
  });

  it('écarte les spectateurs du lobby (arbitre RLCS : 0 partout sur la série)', () => {
    const withReferee: BallchasingReplayDetail = {
      ...game1,
      orange: {
        ...game1.orange,
        players: [
          ...(game1.orange?.players ?? []),
          { name: 'RLCS REFEREE 16', stats: { core: { goals: 0, assists: 0, saves: 0, shots: 0, score: 0 } } },
        ],
      },
    };
    const lines = mapBallchasingReplays([withReferee], { name: 'Team BDS' }, { name: 'Karmine Corp' });
    expect(lines.map((line) => line.externalName)).not.toContain('RLCS REFEREE 16');
    expect(lines).toHaveLength(3);
  });

  it('ignore les joueurs sans pseudo', () => {
    const partial: BallchasingReplayDetail = {
      blue: { name: 'Team BDS', players: [{ name: 'Seikoo', stats: { core: { saves: 2 } } }, {}] },
      orange: { name: 'Karmine Corp', players: [] },
    };
    const lines = mapBallchasingReplays([partial], { name: 'Team BDS' }, { name: 'Karmine Corp' });
    expect(lines).toHaveLength(1);
    expect(lines[0].normalized).toEqual({
      goals: 0,
      assists: 0,
      saves: 2,
      shots: 0,
      score: 0,
      demosInflicted: 0,
      boostBpm: 0,
      shootingPct: null,
      bcpm: 0,
      demosTaken: 0,
    });
  });
});

describe('mapBallchasingGames', () => {
  it('projette chaque replay en manche, score ramené au côté A/B', () => {
    expect(mapBallchasingGames([game1, game2], { name: 'Team BDS' })).toEqual([
      { position: 1, map: 'DFH Stadium', scoreA: 3, scoreB: 1 },
      { position: 2, map: 'Mannfield', scoreA: 4, scoreB: 2 },
    ]);
  });

  it('lit les buts d’équipe du détail (stats.core.goals) en priorité', () => {
    const detail: BallchasingReplayDetail = {
      map_name: 'Utopia Coliseum',
      blue: { name: 'Team BDS', stats: { core: { goals: 5 } } },
      orange: { name: 'Karmine Corp', stats: { core: { goals: 2 } } },
    };
    expect(mapBallchasingGames([detail], { name: 'Karmine Corp' })).toEqual([
      { position: 1, map: 'Utopia Coliseum', scoreA: 2, scoreB: 5 },
    ]);
  });
});
