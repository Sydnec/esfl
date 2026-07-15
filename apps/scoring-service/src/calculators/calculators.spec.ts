import { describe, expect, it } from 'vitest';
import {
  canonicalLolRole,
  computePlayerScore,
  Distribution,
  DistributionLookup,
  distributionRole,
  extractMetrics,
  mapsPlayed,
  MIN_DISTRIBUTION_SAMPLE,
  ZTOTAL_METRIC,
} from './calculators';

describe('mapsPlayed', () => {
  it('compte les manches décidées, sinon les scores, sinon 1', () => {
    expect(mapsPlayed({ gamesSummary: [{ position: 1, winner: 'A' }, { position: 2, winner: null }] })).toBe(1);
    expect(mapsPlayed({ scoreA: 2, scoreB: 1 })).toBe(3);
    expect(mapsPlayed({})).toBe(1);
  });
});

describe('extractMetrics', () => {
  it('cs2 : compteurs ramenés par map, objectifs = plants+defuses', () => {
    const m = extractMetrics('cs2', { kills: 20, deaths: 10, assists: 6, firstKills: 4, plants: 3, defuses: 1 }, 2);
    expect(m.kills).toBe(10);
    expect(m.firstKills).toBe(2);
    expect(m.objectives).toBe(2); // (3+1)/2
  });
  it('valorant : les taux (adr, kast) ne sont pas divisés par les maps', () => {
    const m = extractMetrics('valorant', { kills: 30, deaths: 20, assists: 8, adr: 150, kast: 72, firstKills: 6, firstDeaths: 4 }, 2);
    expect(m.adr).toBe(150);
    expect(m.kast).toBe(72);
    expect(m.assists).toBe(4);
  });
});

describe('canonicalLolRole / distributionRole', () => {
  it('normalise les rôles LoL', () => {
    expect(canonicalLolRole('Bot')).toBe('ADC');
    expect(canonicalLolRole('jungle')).toBe('JUN');
    expect(canonicalLolRole('support')).toBe('SUP');
    expect(canonicalLolRole('Middle')).toBe('MID');
    expect(canonicalLolRole(null)).toBe('Autre');
  });
  it('rôle de distribution : vide hors LoL', () => {
    expect(distributionRole('cs2', 'entry')).toBe('');
    expect(distributionRole('lol', 'Bot')).toBe('ADC');
  });
});

describe('computePlayerScore', () => {
  const dist = (mean: number, stddev: number): Distribution => ({
    mean,
    stddev,
    sampleSize: MIN_DISTRIBUTION_SAMPLE,
  });
  // Métriques standardisées via `dist`, Z_total non re-standardisé (lookup vide).
  const lookupWith = (mean: number, stddev: number): DistributionLookup => (_g, _r, metric) =>
    metric === ZTOTAL_METRIC ? undefined : dist(mean, stddev);

  it('un joueur exactement à la moyenne obtient 50', () => {
    const lookup = lookupWith(10, 5);
    const result = computePlayerScore(
      'cs2',
      { kills: 10, deaths: 10, assists: 10, firstKills: 10, plants: 5, defuses: 5 },
      1,
      null,
      lookup,
    );
    expect(result?.points).toBe(50);
  });

  it('au-dessus de la moyenne → score > 50 ; échantillon insuffisant → Z=0', () => {
    const strong = computePlayerScore(
      'valorant',
      { kills: 30, deaths: 5, assists: 10, adr: 200, kast: 90, firstKills: 12, firstDeaths: 1 },
      1,
      null,
      lookupWith(100, 20),
    );
    expect(strong && strong.points).toBeGreaterThan(50);

    // Distribution sous le seuil d'échantillon → aucune standardisation → 50.
    const small = computePlayerScore(
      'valorant',
      { kills: 30, deaths: 5, assists: 10, adr: 200, kast: 90, firstKills: 12, firstDeaths: 1 },
      1,
      null,
      () => ({ mean: 100, stddev: 20, sampleSize: 5 }),
    );
    expect(small?.points).toBe(50);
  });
});
