import { describe, expect, it } from 'vitest';
import { asFieldSources, pandascoreUpdate, providerUpdate } from './field-precedence';

describe('pandascoreUpdate', () => {
  it('n’écrase pas un champ possédé par un provider', () => {
    const update = pandascoreUpdate(
      { name: 'Gen.G', acronym: 'GEN', imageUrl: 'ps.png' },
      { name: 'vlr', imageUrl: 'vlr' },
    );
    expect(update).toEqual({ acronym: 'GEN' });
  });

  it('écrit tout (y compris null) quand rien n’est possédé', () => {
    const update = pandascoreUpdate({ name: 'Gen.G', acronym: null }, null);
    expect(update).toEqual({ name: 'Gen.G', acronym: null });
  });
});

describe('providerUpdate', () => {
  it('écrase les champs renseignés et les marque possédés', () => {
    const { data, fieldSources } = providerUpdate(
      { name: 'Gen.G Esports', acronym: 'GEN' },
      'vlr',
      null,
    );
    expect(data).toEqual({ name: 'Gen.G Esports', acronym: 'GEN' });
    expect(fieldSources).toEqual({ name: 'vlr', acronym: 'vlr' });
  });

  it('ignore les valeurs null/undefined (le fallback Pandascore reste en place)', () => {
    const { data, fieldSources } = providerUpdate(
      { name: 'T1', imageUrl: null, location: undefined },
      'leaguepedia',
      null,
    );
    expect(data).toEqual({ name: 'T1' });
    expect(fieldSources).toEqual({ name: 'leaguepedia' });
  });

  it('fusionne la possession multi-providers sans perdre l’existant', () => {
    const { fieldSources } = providerUpdate(
      { role: 'Bot' },
      'leaguepedia',
      { name: 'vlr' },
    );
    expect(fieldSources).toEqual({ name: 'vlr', role: 'leaguepedia' });
  });
});

describe('asFieldSources', () => {
  it('tolère les Json inattendus (null, tableau, valeurs non-string)', () => {
    expect(asFieldSources(null)).toEqual({});
    expect(asFieldSources(['vlr'])).toEqual({});
    expect(asFieldSources({ name: 'vlr', poids: 3 })).toEqual({ name: 'vlr' });
  });
});
