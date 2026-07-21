import { describe, expect, it } from 'vitest';
import {
  buildPlayerIndex,
  inferOpponentAlias,
  matchPlayer,
  normalizeName,
  pseudosProches,
  teamMatches,
  teamMatchesExact,
  teamNamesMatch,
} from './matching';

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

describe('teamMatches', () => {
  it('reconnaît le nom Pandascore et les alias appris', () => {
    const team = { name: 'largadosypelados', aliases: ['LP'] };
    expect(teamMatches('largadosypelados', team)).toBe(true);
    expect(teamMatches('LP', team)).toBe(true);
    expect(teamMatches('Fake do Biru', team)).toBe(false);
    expect(teamMatches('LP', { name: 'largadosypelados' })).toBe(false);
  });

  it('matche les alias en exact, jamais en sous-chaîne (pas de collision d’alias court)', () => {
    const team = { name: 'largadosypelados', aliases: ['LP'] };
    // « LP » ne doit pas absorber une équipe tierce dont le nom le contient.
    expect(teamMatches('LPL', team)).toBe(false);
    expect(teamMatches('Liquid Pro', team)).toBe(false);
    // Le nom Pandascore, lui, reste rapproché en flou.
    expect(teamMatches('largados y pelados', team)).toBe(true);
  });
});

describe('teamMatchesExact', () => {
  it('égalité normalisée exacte sur le nom ou un alias', () => {
    const team = { name: 'Cloud9', aliases: ['C9'] };
    expect(teamMatchesExact('Cloud9', team)).toBe(true);
    expect(teamMatchesExact('cloud 9', team)).toBe(true); // normalisation
    expect(teamMatchesExact('C9', team)).toBe(true);
  });

  it('ne matche PAS une équipe dérivée dont le nom contient le nôtre', () => {
    const team = { name: 'Cloud9', aliases: [] };
    // C'est tout l'objet du correctif : « Cloud9 Academy » ⊃ « Cloud9 ».
    expect(teamMatchesExact('Cloud9 Academy', team)).toBe(false);
    expect(teamMatchesExact('Cloud9 Kia', team)).toBe(false);
    expect(teamMatchesExact('Sentinels GC', { name: 'Sentinels' })).toBe(false);
  });

  it('chaîne vide ne matche jamais', () => {
    expect(teamMatchesExact('', { name: 'Cloud9' })).toBe(false);
  });
});

describe('inferOpponentAlias', () => {
  const teamA = { name: 'largadosypelados' };
  const teamB = { name: 'Fake do Biru' };

  it('apprend le nom inconnu quand une seule équipe est reconnue', () => {
    const pairs = [
      { nameA: 'LPX Prime', nameB: 'Fake do Biru', deltaMs: 10 * 60 * 1000 },
      { nameA: 'Vitality', nameB: 'NAVI', deltaMs: 0 },
    ];
    expect(inferOpponentAlias(pairs, teamA, teamB, 2 * 3600 * 1000)).toEqual({
      team: 'A',
      alias: 'LPX Prime',
    });
  });

  it('refuse un nom trop court comme alias (« LP », « 2 »)', () => {
    const pairs = [{ nameA: 'LP', nameB: 'Fake do Biru', deltaMs: 0 }];
    expect(inferOpponentAlias(pairs, teamA, teamB, 2 * 3600 * 1000)).toBeNull();
  });

  it('s’abstient si deux candidats distincts se dégagent (équipe multi-matchs)', () => {
    const pairs = [
      { nameA: 'Fake do Biru', nameB: 'Inconnu 1', deltaMs: 0 },
      { nameA: 'Fake do Biru', nameB: 'Inconnu 2', deltaMs: 30 * 60 * 1000 },
    ];
    expect(inferOpponentAlias(pairs, teamA, teamB, 2 * 3600 * 1000)).toBeNull();
  });

  it('ignore les affiches trop loin du coup d’envoi', () => {
    const pairs = [{ nameA: 'Fake do Biru', nameB: 'LGP', deltaMs: 5 * 3600 * 1000 }];
    expect(inferOpponentAlias(pairs, teamA, teamB, 2 * 3600 * 1000)).toBeNull();
    // Sans contrainte de temps (fenêtre déjà resserrée côté appelant), il apprend.
    expect(inferOpponentAlias(pairs, teamA, teamB)).toEqual({ team: 'A', alias: 'LGP' });
  });

  it('n’apprend pas quand les deux équipes sont déjà reconnues', () => {
    const pairs = [{ nameA: 'largadosypelados', nameB: 'Fake do Biru', deltaMs: 0 }];
    expect(inferOpponentAlias(pairs, teamA, teamB)).toBeNull();
  });
});

describe('pseudosProches', () => {
  it('rapproche l’identique, le leetspeak et l’inclusion', () => {
    expect(pseudosProches('AdrieN', 'adrien')).toBe(true);
    expect(pseudosProches('sh1n', 'Shin')).toBe(true);
    expect(pseudosProches('Djon', 'Djon8')).toBe(true);
  });

  it('tolère une lettre d’écart au-delà de 4 caractères', () => {
    // Cas réel : deux fiches de Sergey Zhukovich.
    expect(pseudosProches('Kurama', 'Kuruma')).toBe(true);
  });

  it('refuse une lettre d’écart sur un pseudo court, trop ambigu', () => {
    expect(pseudosProches('ropz', 'ropk')).toBe(false);
  });

  it('refuse deux pseudos sans rapport', () => {
    expect(pseudosProches('dako', 'BLVCKM4GIC')).toBe(false);
    expect(pseudosProches('GIDEON', 'Heru')).toBe(false);
  });

  it('refuse un pseudo vide', () => {
    expect(pseudosProches('', 'ZywOo')).toBe(false);
  });
});
