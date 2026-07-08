import { describe, expect, it } from 'vitest';
import { computeScore, scoreCs2, scoreLol, scoreRl, scoreValorant } from './calculators';

describe('calculateurs de points', () => {
  it('cs2 : bonne perf ≈ 20-40 pts', () => {
    const { points, breakdown } = scoreCs2({
      kills: 25,
      deaths: 15,
      assists: 5,
      adr: 90,
      rating: 1.2,
    });
    expect(points).toBeCloseTo(25 * 2 + 5 - 15 + 4.5, 1);
    expect(breakdown.kills).toBe(50);
  });

  it('valorant : ACS et first kills comptent', () => {
    const { points } = scoreValorant({
      kills: 20,
      deaths: 12,
      assists: 6,
      acs: 240,
      firstKills: 3,
    });
    expect(points).toBeCloseTo(30 + 4.8 - 12 + 12 + 4.5, 1);
  });

  it('lol : la victoire apporte un bonus fixe', () => {
    const win = scoreLol({ kills: 4, deaths: 2, assists: 8, csPerMin: 8, win: true });
    const loss = scoreLol({ kills: 4, deaths: 2, assists: 8, csPerMin: 8, win: false });
    expect(win.points - loss.points).toBe(5);
  });

  it('rl : le barème valorise les buts', () => {
    const { points } = scoreRl({ goals: 2, assists: 1, saves: 3, shots: 5, score: 550 });
    expect(points).toBeCloseTo(16 + 5 + 12 + 5 + 5.5, 1);
  });

  it('computeScore rejette des stats invalides', () => {
    expect(computeScore('cs2', { kills: 'beaucoup' })).toBeNull();
    expect(computeScore('lol', {})).toBeNull();
  });

  it('computeScore route vers la bonne formule', () => {
    const result = computeScore('rl', { goals: 1, assists: 0, saves: 0, shots: 1, score: 100 });
    expect(result?.points).toBeCloseTo(8 + 1 + 1, 1);
  });
});
