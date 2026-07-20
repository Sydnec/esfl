import { describe, expect, it } from 'vitest';
import { nameVariants } from './player-adoption.service';

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
