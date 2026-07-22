import { describe, expect, it } from 'vitest';
import {
  disambiguate,
  nameVariants,
  PlayerAdoptionService,
  realNameKey,
} from './player-adoption.service';
import type { PSPlayer } from '../pandascore/pandascore.types';

/** Candidat Pandascore minimal pour les tests de départage. */
function candidate(
  id: number,
  first: string | null,
  last: string | null,
  nationality: string | null = null,
): PSPlayer {
  return {
    id,
    name: 'homonyme',
    first_name: first,
    last_name: last,
    image_url: null,
    role: null,
    nationality,
    current_team: null,
  };
}

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

describe('disambiguate', () => {
  const noIdentity = { firstName: null, lastName: null, nationality: null };

  it('deux vrais homonymes distincts (patronymes différents, aucun indice local) → arbitrage', () => {
    // Cas réel « salazar » CS2 : Kirill Rautskiy vs Jason Salazar.
    const cands = [candidate(1, 'Kirill', 'Rautskiy'), candidate(2, 'Jason', 'Salazar')];
    expect(disambiguate(noIdentity, cands)).toEqual([]);
  });

  it('patronyme identique chez tous les candidats → doublon Pandascore, on réunit', () => {
    const cands = [candidate(1, 'Lee', 'Sang-hyeok'), candidate(2, 'Lee', 'Sang-hyeok')];
    expect(disambiguate(noIdentity, cands).map((c) => c.id)).toEqual([1, 2]);
  });

  it('notre patronyme isole exactement un candidat → adoption', () => {
    const cands = [candidate(1, 'Kirill', 'Rautskiy'), candidate(2, 'Jason', 'Salazar')];
    const ours = { firstName: 'Jason', lastName: 'Salazar', nationality: null };
    expect(disambiguate(ours, cands).map((c) => c.id)).toEqual([2]);
  });

  it('notre patronyme (ordre inversé) désigne le bon candidat', () => {
    const cands = [candidate(1, 'Faker', null), candidate(2, 'Sang-hyeok', 'Lee')];
    const ours = { firstName: 'Lee', lastName: 'Sang-hyeok', nationality: null };
    expect(disambiguate(ours, cands).map((c) => c.id)).toEqual([2]);
  });

  it('à défaut de patronyme, la nationalité isole un candidat', () => {
    const cands = [candidate(1, null, null, 'KR'), candidate(2, null, null, 'CN')];
    const ours = { firstName: null, lastName: null, nationality: 'cn' };
    expect(disambiguate(ours, cands).map((c) => c.id)).toEqual([2]);
  });

  it('même nationalité pour plusieurs candidats → pas de départage', () => {
    const cands = [candidate(1, null, null, 'KR'), candidate(2, null, null, 'KR')];
    const ours = { firstName: null, lastName: null, nationality: 'KR' };
    expect(disambiguate(ours, cands)).toEqual([]);
  });

  it('candidats tous sans patronyme ne sont jamais réunis à tort', () => {
    const cands = [candidate(1, null, null), candidate(2, null, null)];
    expect(disambiguate(noIdentity, cands)).toEqual([]);
  });
});

describe('adoptOrphans, passages concurrents', () => {
  /** Service câblé sur un Prisma qui ne rend aucun orphelin, sauf blocage. */
  function service(findMany: () => Promise<unknown[]>) {
    return new PlayerAdoptionService(
      { player: { findMany } } as never,
      { enabled: true } as never,
      { gameId: 'cs2' } as never,
      { gameId: 'valorant' } as never,
      { gameId: 'lol' } as never,
    );
  }

  it('refuse un second passage tant que le premier tourne', async () => {
    let debloquer!: () => void;
    const premierLot = new Promise<void>((resolve) => {
      debloquer = resolve;
    });
    let appels = 0;
    const sujet = service(async () => {
      appels += 1;
      await premierLot;
      return [];
    });

    const premier = sujet.adoptOrphans();
    await Promise.resolve();
    const second = await sujet.adoptOrphans();

    // Le second rend un rapport vide sans avoir touché la base.
    expect(second).toEqual({
      orphelins: 0,
      adoptes: 0,
      fusionnes: 0,
      ambigus: 0,
      introuvables: 0,
      erreurs: 0,
    });
    expect(appels).toBe(1);

    debloquer();
    await premier;

    // Le verrou est rendu : le passage suivant repart.
    await sujet.adoptOrphans();
    expect(appels).toBeGreaterThan(1);
  });
});
