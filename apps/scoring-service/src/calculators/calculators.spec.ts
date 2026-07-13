import { describe, expect, it } from 'vitest';
import {
  computeScore,
  mapsPlayed,
  scoreCs2,
  scoreLol,
  scoreRl,
  scoreValorant,
} from './calculators';

describe('calculateurs de points', () => {
  it('cs2 : bonne perf sur 1 map ≈ 20-40 pts', () => {
    const { points, breakdown } = scoreCs2(
      {
        kills: 25,
        deaths: 15,
        assists: 5,
        adr: 90,
        rating: 1.2,
      },
      1,
    );
    expect(points).toBeCloseTo(25 * 2 + 5 - 15 + 4.5, 1);
    expect(breakdown.kills).toBe(50);
  });

  it('cs2 : un Bo3 vaut la même chose que la perf moyenne en Bo1', () => {
    const bo1 = scoreCs2({ kills: 20, deaths: 15, assists: 6, adr: 85, rating: 1.1 }, 1);
    const bo3 = scoreCs2({ kills: 60, deaths: 45, assists: 18, adr: 85, rating: 1.1 }, 3);
    expect(bo3.points).toBeCloseTo(bo1.points, 5);
  });

  it('cs2 : firstKills et objectifs enrichissent le K/A/D (v3)', () => {
    const base = { kills: 20, deaths: 15, assists: 5, adr: null, rating: null };
    const { points: sansExtra } = scoreCs2(base, 1);
    const { points, breakdown } = scoreCs2(
      { ...base, firstKills: 4, plants: 3, defuses: 2 },
      1,
    );
    // +4×1.5 (first kills) +3×0.5 (plants) +2×0.5 (defuses) = +8.5
    expect(breakdown.firstKills).toBeCloseTo(6, 5);
    expect(points - sansExtra).toBeCloseTo(6 + 1.5 + 1, 5);
  });

  it('valorant : ACS et first kills comptent', () => {
    const { points } = scoreValorant(
      {
        kills: 20,
        deaths: 12,
        assists: 6,
        acs: 240,
        firstKills: 3,
      },
      1,
    );
    expect(points).toBeCloseTo(30 + 4.8 - 12 + 12 + 4.5, 1);
  });

  it('valorant : le taux acs n’est pas divisé par les maps', () => {
    const stats = { kills: 40, deaths: 24, assists: 12, acs: 240, firstKills: 6 };
    const { breakdown } = scoreValorant(stats, 2);
    expect(breakdown.acs).toBe(12);
    expect(breakdown.kills).toBe(30);
  });

  it('lol : la victoire apporte un bonus fixe, quel que soit le format', () => {
    const win = scoreLol({ kills: 4, deaths: 2, assists: 8, csPerMin: 8, win: true }, 1);
    const loss = scoreLol({ kills: 4, deaths: 2, assists: 8, csPerMin: 8, win: false }, 1);
    expect(win.points - loss.points).toBe(5);

    const winBo5 = scoreLol({ kills: 20, deaths: 10, assists: 40, csPerMin: 8, win: true }, 5);
    expect(winBo5.breakdown.win).toBe(5);
    expect(winBo5.breakdown.csPerMin).toBe(8);
  });

  it('rl : le barème valorise les buts', () => {
    const { points } = scoreRl({ goals: 2, assists: 1, saves: 3, shots: 5, score: 550 }, 1);
    expect(points).toBeCloseTo(16 + 5 + 12 + 5 + 5.5, 1);
  });

  it('computeScore rejette des stats invalides', () => {
    expect(computeScore('cs2', { kills: 'beaucoup' }, 1)).toBeNull();
    expect(computeScore('lol', {}, 1)).toBeNull();
  });

  it('computeScore route vers la bonne formule et normalise par map', () => {
    const result = computeScore(
      'rl',
      { goals: 2, assists: 0, saves: 0, shots: 2, score: 200 },
      2,
    );
    expect(result?.points).toBeCloseTo(8 + 1 + 1, 1);
  });
});

describe('mapsPlayed', () => {
  it('compte les manches décidées de gamesSummary', () => {
    expect(
      mapsPlayed({
        gamesSummary: [
          { position: 1, winner: 'A' },
          { position: 2, winner: 'B' },
          { position: 3, winner: 'A' },
        ],
      }),
    ).toBe(3);
  });

  it('ignore les manches en cours (winner null)', () => {
    expect(
      mapsPlayed({
        gamesSummary: [
          { position: 1, winner: 'A' },
          { position: 2, winner: null },
        ],
      }),
    ).toBe(1);
  });

  it('retombe sur scoreA+scoreB sans gamesSummary', () => {
    expect(mapsPlayed({ gamesSummary: null, scoreA: 2, scoreB: 1 })).toBe(3);
    expect(mapsPlayed({ scoreA: 2, scoreB: 0 })).toBe(2);
  });

  it('retombe sur 1 sans aucune information', () => {
    expect(mapsPlayed({})).toBe(1);
    expect(mapsPlayed({ gamesSummary: [], scoreA: 0, scoreB: 0 })).toBe(1);
  });
});
