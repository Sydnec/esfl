import { describe, expect, it } from 'vitest';
import { datesDeRattrapage } from './degel-rattrapage';

/**
 * TEMPORAIRE — à supprimer avec `degel-rattrapage.ts`.
 *
 * La fenêtre couvre J-4 à J-7 : les journées que l'ancienne échéance (3 jours)
 * a gelées alors que la nouvelle (7) les laisserait encore ouvertes.
 */
describe('datesDeRattrapage', () => {
  const maintenant = new Date('2026-08-21T10:00:00Z').getTime();

  it('rend les quatre journées J-4 à J-7, de la plus récente à la plus ancienne', () => {
    expect(datesDeRattrapage(maintenant)).toEqual([
      '2026-08-17',
      '2026-08-16',
      '2026-08-15',
      '2026-08-14',
    ]);
  });
});
