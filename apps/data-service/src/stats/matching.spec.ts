import { describe, expect, it } from 'vitest';
import { buildPlayerIndex, matchPlayer, normalizeName, teamNamesMatch } from './matching';

describe('normalizeName', () => {
  it('minuscules, sans diacritiques ni ponctuation', () => {
    expect(normalizeName('M0nkey M00n')).toBe('m0nkeym00n');
    expect(normalizeName('Caps')).toBe('caps');
    expect(normalizeName('Kévin "Kev" Durand')).toBe('kevinkevdurand');
    expect(normalizeName('s1mple')).toBe('s1mple');
  });
});

describe('teamNamesMatch', () => {
  it('tolère les variantes de nommage', () => {
    expect(teamNamesMatch('G2 Esports', 'G2 Esports')).toBe(true);
    expect(teamNamesMatch('G2', 'G2 Esports')).toBe(true);
    expect(teamNamesMatch('Team BDS', 'BDS')).toBe(true);
    expect(teamNamesMatch('Karmine Corp', 'Vitality')).toBe(false);
  });

  it('rejette les noms vides', () => {
    expect(teamNamesMatch('', 'G2')).toBe(false);
  });
});

describe('matchPlayer', () => {
  const index = buildPlayerIndex([
    { id: 'p1', name: 'ZywOo' },
    { id: 'p2', name: 'M0nkey M00n' },
  ]);

  it('rapproche par nom normalisé', () => {
    expect(matchPlayer(index, 'zywoo')?.id).toBe('p1');
    expect(matchPlayer(index, 'M0NKEY M00N')?.id).toBe('p2');
  });

  it('retourne null si inconnu', () => {
    expect(matchPlayer(index, 'inconnu')).toBeNull();
  });
});
