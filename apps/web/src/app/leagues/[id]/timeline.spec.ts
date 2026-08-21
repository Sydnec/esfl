import { describe, expect, it } from 'vitest';
import type { MatchDaySummary } from '@/lib/types';
import { decalageCentrage, journeeParDefaut } from './timeline';

/** Date Paris décalée de `offset` jours (même convention que la page). */
function jour(offset: number): string {
  const now = new Date();
  now.setUTCHours(12, 0, 0, 0);
  now.setUTCDate(now.getUTCDate() + offset);
  return now.toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
}

function day(offset: number, deadlinePassed: boolean): MatchDaySummary {
  return {
    id: `j${offset}`,
    date: jour(offset),
    firstMatchAt: `${jour(offset)}T16:00:00.000Z`,
    deadlinePassed,
    myRosterSubmitted: false,
  };
}

describe('journeeParDefaut', () => {
  it('ouvre sur la journée du jour même quand ses picks sont clos', () => {
    const days = [day(-1, true), day(0, true), day(1, false)];
    expect(journeeParDefaut(days)?.date).toBe(jour(0));
  });

  it('à défaut de journée du jour, ouvre sur la prochaine encore ouverte', () => {
    const days = [day(-2, true), day(-1, true), day(2, false), day(3, false)];
    expect(journeeParDefaut(days)?.date).toBe(jour(2));
  });

  it('saison terminée : ouvre sur la dernière journée jouée', () => {
    const days = [day(-3, true), day(-1, true)];
    expect(journeeParDefaut(days)?.date).toBe(jour(-1));
  });

  it('aucune journée : rien à ouvrir', () => {
    expect(journeeParDefaut([])).toBeNull();
  });
});

/**
 * La timeline s'ouvre sur la PREMIÈRE journée de la ligue (tri par date
 * croissante) : sans recentrage, la pilule du jour est hors écran.
 */
describe('decalageCentrage', () => {
  const timeline = { left: 100, width: 400 };

  it('centre une pilule hors écran à droite', () => {
    // Pilule à 900 : 800 après le bord gauche, à ramener à (400-108)/2 = 146.
    expect(decalageCentrage(timeline, { left: 900, width: 108 })).toBe(654);
  });

  it('centre une pilule hors écran à gauche (décalage négatif)', () => {
    expect(decalageCentrage(timeline, { left: -50, width: 108 })).toBe(-296);
  });

  it('ne bouge pas une pilule déjà entièrement visible', () => {
    expect(decalageCentrage(timeline, { left: 220, width: 108 })).toBe(0);
  });

  it('recentre une pilule seulement à moitié visible', () => {
    expect(decalageCentrage(timeline, { left: 450, width: 108 })).not.toBe(0);
  });
});
