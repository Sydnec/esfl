import { describe, expect, it } from 'vitest';
import { countryToIso2 } from './country-iso';

describe('countryToIso2', () => {
  it('convertit les noms de pays Leaguepedia en ISO2', () => {
    expect(countryToIso2('South Korea')).toBe('KR');
    expect(countryToIso2('united states')).toBe('US');
    expect(countryToIso2('  France ')).toBe('FR');
    expect(countryToIso2('Czechia')).toBe('CZ');
  });

  it('pays inconnu ou vide → null (fallback Pandascore)', () => {
    expect(countryToIso2('Atlantide')).toBeNull();
    expect(countryToIso2('')).toBeNull();
    expect(countryToIso2(null)).toBeNull();
    expect(countryToIso2(undefined)).toBeNull();
  });
});
