import { describe, expect, it } from 'vitest';
import { Sequenceur } from './sequenceur';

describe('Sequenceur', () => {
  it('ignore le passage surnuméraire tant que le premier court', async () => {
    const sequenceur = new Sequenceur();
    let debloquer!: () => void;
    const barriere = new Promise<void>((resolve) => {
      debloquer = resolve;
    });
    let passages = 0;

    const premier = sequenceur.passer(async () => {
      passages += 1;
      await barriere;
      return 'fini';
    });
    await Promise.resolve();
    expect(await sequenceur.passer(async () => 'doublon')).toEqual({ lance: false });
    expect(passages).toBe(1);

    debloquer();
    expect(await premier).toEqual({ lance: true, valeur: 'fini' });
  });

  it('distingue un traitement qui rend null d’un passage ignoré', async () => {
    const sequenceur = new Sequenceur();
    expect(await sequenceur.passer(async () => null)).toEqual({ lance: true, valeur: null });
  });

  it('rend le verrou après le passage, y compris sur erreur', async () => {
    const sequenceur = new Sequenceur();
    await expect(
      sequenceur.passer(async () => {
        throw new Error('boum');
      }),
    ).rejects.toThrow('boum');
    expect(await sequenceur.passer(async () => 'reparti')).toEqual({
      lance: true,
      valeur: 'reparti',
    });
  });
});
