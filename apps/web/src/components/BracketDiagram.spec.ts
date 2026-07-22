import { describe, expect, it } from 'vitest';
import { creneauAPourvoir, roundOf } from './BracketDiagram';

/**
 * Le rang place la colonne, l'index place la carte DANS la colonne et relie
 * l'enfant à son parent (i → ceil(i/2)). Un index erroné empile les cartes.
 */
describe('roundOf', () => {
  it('numérote les matchs d’un tour dont le libellé porte déjà un nombre', () => {
    expect(roundOf('Round of 32 match 10: SIN vs FUT')).toEqual({ rank: 4, index: 10 });
    expect(roundOf('Round of 32 match 1: TL vs VIT')).toEqual({ rank: 4, index: 1 });
    expect(roundOf('Round of 16 match 8: TBD vs TBD')).toEqual({ rank: 3, index: 8 });
  });

  it('donne un index distinct à chaque match des seize', () => {
    const indexes = Array.from(
      { length: 16 },
      (_, i) => roundOf(`Round of 32 match ${i + 1}`)!.index,
    );
    expect(new Set(indexes).size).toBe(16);
  });

  it('classe les tours de playoffs, finale au rang 0', () => {
    expect(roundOf('Quarterfinal 3: TBD vs TBD')).toEqual({ rank: 2, index: 3 });
    expect(roundOf('Semifinal 2: TBD vs TBD')).toEqual({ rank: 1, index: 2 });
    expect(roundOf('Grand final: TBD vs TBD')).toEqual({ rank: 0, index: 1 });
  });

  it('ignore les chiffres des noms d’équipe, après le « : »', () => {
    expect(roundOf('Grand final: 9z vs G2')).toEqual({ rank: 0, index: 1 });
  });

  it('rend null hors d’un tour à élimination', () => {
    expect(roundOf('Group A: TL vs VIT')).toBeNull();
  });
});

describe('creneauAPourvoir', () => {
  const equipe = (id: string, acronym: string) => ({
    id,
    name: `Team ${acronym}`,
    acronym,
    imageUrl: null,
  });
  const base = {
    id: 'm1',
    name: 'Round of 32 match 11',
    winnerTeamId: null,
    status: 'not_started',
  };

  it('nomme les deux adversaires quand le match alimentant n’est pas joué', () => {
    const res = creneauAPourvoir({
      ...base,
      teamA: equipe('a', 'NEMI'),
      teamB: equipe('b', 'G2'),
    } as never);
    expect(res.texte).toBe('NEMI ou G2');
    expect(res.detail).toContain('Round of 32 match 11');
  });

  it('affiche le qualifié dès que le match alimentant est joué', () => {
    const res = creneauAPourvoir({
      ...base,
      status: 'finished',
      winnerTeamId: 'b',
      teamA: equipe('a', 'NEMI'),
      teamB: equipe('b', 'G2'),
    } as never);
    expect(res.texte).toBe('G2');
    expect(res.detail).toContain('Qualifié');
  });

  it('reste à TBD sans match alimentant', () => {
    expect(creneauAPourvoir(null)).toEqual({ texte: 'TBD' });
  });

  it('reste à TBD quand le match alimentant est lui-même indéterminé', () => {
    const res = creneauAPourvoir({ ...base, teamA: null, teamB: null } as never);
    expect(res.texte).toBe('TBD');
  });
});
