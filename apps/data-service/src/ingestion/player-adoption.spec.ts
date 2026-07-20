import { describe, expect, it } from 'vitest';
import { nameVariants, realNameKey } from './player-adoption.service';

/**
 * Graphies soumises à Pandascore : sa recherche par nom est sensible à la
 * casse, ce qui laissait « Xyno » sans réponse alors que « xyno » existe.
 */
describe('nameVariants', () => {
  it('couvre la graphie d’origine, la minuscule et la capitalisée', () => {
    expect(nameVariants('Xyno').sort()).toEqual(['Xyno', 'xyno']);
    expect(nameVariants('MATYS').sort()).toEqual(['MATYS', 'Matys', 'matys']);
    expect(nameVariants('salazar').sort()).toEqual(['Salazar', 'salazar']);
  });

  it('dédoublonne quand les graphies coïncident', () => {
    expect(nameVariants('Faker')).toEqual(['Faker', 'faker']);
  });

  it('ignore une saisie vide', () => {
    expect(nameVariants('   ')).toEqual([]);
  });

  it('laisse intacts les pseudos non alphabétiques', () => {
    expect(nameVariants('123')).toEqual(['123']);
  });
});

describe('realNameKey', () => {
  it('absorbe l’ordre, la ponctuation et les diacritiques', () => {
    // Leaguepedia publie « Lee Sang-hyeok », Pandascore « Lee » + « Sang-hyeok ».
    expect(realNameKey('Lee Sang-hyeok')).toBe(realNameKey('Lee', 'Sang-hyeok'));
    // L'ordre prénom/nom varie selon les sources sur les noms coréens.
    expect(realNameKey('Sang-hyeok', 'Lee')).toBe(realNameKey('Lee', 'Sang-hyeok'));
    expect(realNameKey('Hubert Mikoś')).toBe(realNameKey('Hubert', 'Mikos'));
  });

  it('distingue deux personnes différentes', () => {
    // Cas réel : deux « salazar » en CS2.
    expect(realNameKey('Kirill', 'Rautskiy')).not.toBe(realNameKey('Jason', 'Salazar'));
  });

  it('rend une chaîne vide quand la source ne publie rien', () => {
    expect(realNameKey(null, undefined)).toBe('');
    expect(realNameKey('  ')).toBe('');
  });
});
