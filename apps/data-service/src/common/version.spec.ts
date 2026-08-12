import { describe, expect, it } from 'vitest';
import { identiteVersion } from '@esfl/contracts';

// Comme `verifierUrlsServices` : le helper vit dans @esfl/contracts, partagé par
// les cinq services, qui n'a pas de runner de tests.
describe('identiteVersion', () => {
  it('rend la version et le commit gravés dans l’image', () => {
    expect(identiteVersion({ APP_VERSION: '0.2.0', APP_COMMIT: 'a1b2c3d' })).toEqual({
      version: '0.2.0',
      commit: 'a1b2c3d',
    });
  });

  it('annonce un build non identifiable plutôt qu’une version inventée', () => {
    expect(identiteVersion({})).toEqual({ version: 'dev', commit: 'local' });
  });

  it('traite une valeur vide comme absente (ARG non transmis au build)', () => {
    expect(identiteVersion({ APP_VERSION: '', APP_COMMIT: '  ' })).toEqual({
      version: 'dev',
      commit: 'local',
    });
  });
});
