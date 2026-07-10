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

  it('repli leetspeak : sh1n (VLR) rejoint Shin (Pandascore)', () => {
    const leet = buildPlayerIndex([
      { id: 'p1', name: 'Shin' },
      { id: 'p2', name: 'TakaS' },
    ]);
    expect(matchPlayer(leet, 'sh1n')?.id).toBe('p1');
    // Les pseudos nativement leet restent inchangés des deux côtés.
    const native = buildPlayerIndex([{ id: 'p1', name: 's1mple' }]);
    expect(matchPlayer(native, 's1mple')?.id).toBe('p1');
  });

  it('repli par inclusion unique : variantes de pseudo entre sources', () => {
    const variants = buildPlayerIndex([
      { id: 'p1', name: 'Djon8' },
      { id: 'p2', name: 'TRAVIS' },
    ]);
    // « Djon » (Grid) ⊂ « Djon8 » (Pandascore), une seule inclusion possible.
    expect(matchPlayer(variants, 'Djon')?.id).toBe('p1');
    expect(matchPlayer(variants, 'k4nfuz-')).toBeNull();
  });

  it('refuse le repli ambigu ou trop court', () => {
    const ambiguous = buildPlayerIndex([
      { id: 'p1', name: 'maxster' },
      { id: 'p2', name: 'maxie' },
    ]);
    expect(matchPlayer(ambiguous, 'max')).toBeNull();
    const short = buildPlayerIndex([{ id: 'p1', name: 'H3ro' }]);
    expect(matchPlayer(short, 'h3')).toBeNull();
  });
});
