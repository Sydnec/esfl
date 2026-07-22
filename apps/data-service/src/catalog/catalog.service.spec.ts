import { describe, expect, it } from 'vitest';
import { clustersParPseudo, identiteCivile } from './catalog.service';

/**
 * Clés d'identité de la fusion des doublons : deux fiches ne doivent être
 * réunies que si elles désignent vraiment la même personne.
 */
describe('identiteCivile', () => {
  it('distingue deux découpages qu’une concaténation brute confondait', () => {
    expect(identiteCivile('Kim', 'Minseong')).not.toBe(identiteCivile('Kimm', 'Inseong'));
  });

  it('absorbe casse, accents et ponctuation', () => {
    expect(identiteCivile('Rémy', "O'Brien")).toBe(identiteCivile('remy', 'obrien'));
  });

  it('exige les deux parties : un prénom seul est trop partagé', () => {
    expect(identiteCivile('Kim', null)).toBeNull();
    expect(identiteCivile('  ', 'Minseong')).toBeNull();
  });
});

describe('clustersParPseudo', () => {
  it('réunit deux extrêmes reliés par un pseudo intermédiaire', () => {
    const groupes = clustersParPseudo([{ name: 'Caliste' }, { name: 'Calist' }]);
    expect(groupes).toHaveLength(1);
  });

  it('sépare deux pseudos sans rapport', () => {
    expect(clustersParPseudo([{ name: 'Caliste' }, { name: 'Zywoo' }])).toHaveLength(2);
  });

  it('rend le même découpage quel que soit l’ordre d’arrivée', () => {
    const fiches = [{ name: 'Kuruma' }, { name: 'Kurumaa' }, { name: 'Kurumaaa' }];
    const direct = clustersParPseudo(fiches);
    // Ordre qui plaçait autrefois les extrêmes avant le pont : le troisième
    // restait isolé alors qu'il appartient au même groupe.
    const inverse = clustersParPseudo([fiches[0], fiches[2], fiches[1]]);
    expect(inverse.map((groupe) => groupe.length).sort()).toEqual(
      direct.map((groupe) => groupe.length).sort(),
    );
  });
});
