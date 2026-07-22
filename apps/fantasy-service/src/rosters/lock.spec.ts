import { describe, expect, it } from 'vitest';
import { isLockedForDay, unlockDate } from './lock';

const days = ['2026-07-01', '2026-07-03', '2026-07-05', '2026-07-08', '2026-07-10'];

describe('isLockedForDay', () => {
  it('verrouille la journée suivante avec N=1', () => {
    expect(
      isLockedForDay({
        leagueDayDates: days,
        sourceDate: '2026-07-01',
        targetDate: '2026-07-03',
        lockMatchDays: 1,
      }),
    ).toBe(true);
  });

  it('libère après N journées écoulées avec N=1', () => {
    expect(
      isLockedForDay({
        leagueDayDates: days,
        sourceDate: '2026-07-01',
        targetDate: '2026-07-05',
        lockMatchDays: 1,
      }),
    ).toBe(false);
  });

  it('verrouille deux journées avec N=2', () => {
    expect(
      isLockedForDay({
        leagueDayDates: days,
        sourceDate: '2026-07-01',
        targetDate: '2026-07-05',
        lockMatchDays: 2,
      }),
    ).toBe(true);
    expect(
      isLockedForDay({
        leagueDayDates: days,
        sourceDate: '2026-07-01',
        targetDate: '2026-07-08',
        lockMatchDays: 2,
      }),
    ).toBe(false);
  });

  it('ne verrouille jamais avec N=0', () => {
    expect(
      isLockedForDay({
        leagueDayDates: days,
        sourceDate: '2026-07-01',
        targetDate: '2026-07-03',
        lockMatchDays: 0,
      }),
    ).toBe(false);
  });

  it('ignore la même journée et le passé', () => {
    expect(
      isLockedForDay({
        leagueDayDates: days,
        sourceDate: '2026-07-05',
        targetDate: '2026-07-05',
        lockMatchDays: 3,
      }),
    ).toBe(false);
    expect(
      isLockedForDay({
        leagueDayDates: days,
        sourceDate: '2026-07-05',
        targetDate: '2026-07-03',
        lockMatchDays: 3,
      }),
    ).toBe(false);
  });

  it('compte uniquement les journées existantes de la ligue (pas les jours calendaires)', () => {
    // Entre le 01 et le 08 il y a deux journées (03 et 05) : N=2 → libéré le 08.
    expect(
      isLockedForDay({
        leagueDayDates: days,
        sourceDate: '2026-07-01',
        targetDate: '2026-07-08',
        lockMatchDays: 2,
      }),
    ).toBe(false);
  });
});

describe('unlockDate', () => {
  it('retourne la première journée où le joueur est de nouveau disponible', () => {
    expect(unlockDate({ leagueDayDates: days, sourceDate: '2026-07-01', lockMatchDays: 1 })).toBe(
      '2026-07-05',
    );
    expect(unlockDate({ leagueDayDates: days, sourceDate: '2026-07-01', lockMatchDays: 2 })).toBe(
      '2026-07-08',
    );
  });

  it('retourne null quand la journée de déblocage est inconnue', () => {
    expect(unlockDate({ leagueDayDates: days, sourceDate: '2026-07-10', lockMatchDays: 1 })).toBe(
      null,
    );
  });
});
