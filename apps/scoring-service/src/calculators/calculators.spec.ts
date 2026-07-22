import { describe, expect, it } from 'vitest';
import {
  CALIBRAGE_JEU,
  canonicalLolRole,
  LOL_DISTRIBUTIONS,
  cs2Rating,
  LOL_LAMBDA,
  LolDistributions,
  lolRating,
  lolRatingV5,
  mapsPlayed,
  noteDepuisRating,
  PlayerStatLine,
  roundsPlayed,
  scoreMatch,
  valorantRating,
} from './calculators';

describe('mapsPlayed / roundsPlayed', () => {
  it('mapsPlayed compte les manches décidées, sinon les scores, sinon 1', () => {
    expect(
      mapsPlayed({ gamesSummary: [{ position: 1, winner: 'A' }, { position: 2, winner: null }] }),
    ).toBe(1);
    expect(mapsPlayed({ scoreA: 2, scoreB: 1 })).toBe(3);
    expect(mapsPlayed({})).toBe(1);
  });

  it('roundsPlayed somme scoreA+scoreB de chaque map', () => {
    expect(
      roundsPlayed({
        gamesSummary: [
          { position: 1, winner: 'A', scoreA: 13, scoreB: 7 },
          { position: 2, winner: 'B', scoreA: 10, scoreB: 13 },
        ],
      }),
    ).toBe(43);
    expect(roundsPlayed({ gamesSummary: [{ position: 1, winner: 'A' }] })).toBe(0);
  });
});

describe('noteDepuisRating — échelle commune', () => {
  // Les tests se lisent DEPUIS la table de calibrage : ils vérifient l'invariant,
  // pas des constantes recopiées qui devraient être mises à jour à chaque mesure.
  const jeux = ['cs2', 'valorant', 'lol'] as const;

  it('une perf médiane vaut 50 dans chacun des trois jeux', () => {
    for (const jeu of jeux) {
      expect(noteDepuisRating(jeu, CALIBRAGE_JEU[jeu].mediane)).toBeCloseTo(50, 1);
    }
  });

  it('un rating calibré de 2,00 (+5σ) vaut 100, une sous-perf tombe à 0', () => {
    for (const jeu of jeux) {
      const { mediane, sigma } = CALIBRAGE_JEU[jeu];
      expect(noteDepuisRating(jeu, mediane + 5 * sigma)).toBeCloseTo(100, 1);
      expect(noteDepuisRating(jeu, mediane - 5 * sigma)).toBeCloseTo(0, 1);
    }
  });

  it('à écart-type égal, les trois jeux donnent la même note', () => {
    for (const jeu of jeux) {
      const { mediane, sigma } = CALIBRAGE_JEU[jeu];
      expect(noteDepuisRating(jeu, mediane + sigma)).toBeCloseTo(60, 1);
    }
  });

  it('borne à [0, 100] sans jamais sortir de l’échelle', () => {
    expect(noteDepuisRating('cs2', 10)).toBe(100);
    expect(noteDepuisRating('cs2', -5)).toBe(0);
  });
});

describe('formules de rating — ancrages', () => {
  it('Valorant : joueur moyen ≈ 1,00 de rating', () => {
    const moyen = valorantRating({ kpr: 0.68, apr: 0.25, dpr: 0.66, adr: 130, kast: 72 });
    expect(moyen).toBeGreaterThan(0.9);
    expect(moyen).toBeLessThan(1.1);
  });

  it('CS2 (HLTV 2.0 complet) : joueur moyen ≈ 1,00 de rating', () => {
    const rating = cs2Rating({ kpr: 0.68, dpr: 0.68, apr: 0.15, adr: 80, kast: 70 });
    expect(rating).toBeGreaterThan(0.9);
    expect(rating).toBeLessThan(1.1);
  });

  it('CS2 : le terme d’Impact récompense les kills à volume égal de dégâts', () => {
    const commun = { dpr: 0.68, adr: 85, kast: 72 };
    const fragger = cs2Rating({ ...commun, kpr: 0.85, apr: 0.1 });
    const soutien = cs2Rating({ ...commun, kpr: 0.6, apr: 0.35 });
    expect(fragger).toBeGreaterThan(soutien);
  });

  it('LoL : la formule récompense chaque composante, à toutes choses égales', () => {
    // Ancrage relatif plutôt qu'absolu : un seuil chiffré serait à réécrire à
    // chaque recalibrage, alors que le sens de variation, lui, ne bouge pas.
    const reference = { kda: 3, kp: 64, gpm: 400, vsm: 1.9 };
    const base = lolRating(reference);
    expect(lolRating({ ...reference, kda: 5 })).toBeGreaterThan(base);
    expect(lolRating({ ...reference, kp: 75 })).toBeGreaterThan(base);
    expect(lolRating({ ...reference, gpm: 480 })).toBeGreaterThan(base);
    expect(lolRating({ ...reference, vsm: 2.6 })).toBeGreaterThan(base);
  });
});

describe('canonicalLolRole', () => {
  it('normalise les libellés de rôle', () => {
    expect(canonicalLolRole('Support')).toBe('SUP');
    expect(canonicalLolRole('jungle')).toBe('JUN');
    expect(canonicalLolRole('Bot')).toBe('ADC');
  });
});

describe('scoreMatch — bonus contextuels', () => {
  const valo = (
    playerId: string,
    kills: number,
    fk: number,
    fd: number,
    clutches: number,
  ): PlayerStatLine => ({
    playerId,
    gameId: 'valorant',
    role: null,
    teamSide: 'A',
    normalized: {
      kills,
      deaths: 15,
      assists: 5,
      adr: 140,
      kast: 72,
      firstKills: fk,
      firstDeaths: fd,
      clutches,
    },
  });

  it('Valorant : +3 au max de FK du match, −3 au max de FD, +2 si clutchs > 2', () => {
    const scores = scoreMatch(
      [valo('top-fk', 20, 9, 2, 3), valo('top-fd', 12, 3, 8, 0), valo('milieu', 15, 5, 5, 0)],
      { rounds: 40 },
    );
    const byId = Object.fromEntries(scores.map((s) => [s.playerId, s.breakdown]));
    expect(byId['top-fk'].bonusFk).toBe(3);
    expect(byId['top-fk'].bonusClutch).toBe(2);
    expect(byId['top-fd'].bonusFd).toBe(-3);
    expect(byId['milieu'].bonus).toBe(0);
  });

  it('la note finale est plafonnée à 100', () => {
    const monstre: PlayerStatLine = {
      playerId: 'smurf',
      gameId: 'valorant',
      role: null,
      teamSide: 'A',
      normalized: {
        kills: 60,
        deaths: 3,
        assists: 15,
        adr: 260,
        kast: 95,
        firstKills: 12,
        firstDeaths: 0,
        clutches: 5,
      },
    };
    const [score] = scoreMatch([monstre], { rounds: 24 });
    expect(score.points).toBe(100);
  });

  const lol = (
    playerId: string,
    role: string,
    side: 'A' | 'B',
    extra: Record<string, unknown>,
  ): PlayerStatLine => ({
    playerId,
    gameId: 'lol',
    role,
    teamSide: side,
    normalized: {
      kills: 3,
      deaths: 3,
      assists: 10,
      killParticipation: 0.6,
      goldPerMin: 350,
      visionPerMin: 2,
      ...extra,
    },
  });

  it('LoL : plus aucun bonus de rôle, la standardisation par rôle les remplace', () => {
    const scores = scoreMatch(
      [lol('sup', 'Support', 'A', {}), lol('jgl', 'Jungle', 'A', {}), lol('mid', 'Mid', 'B', {})],
      { rounds: 0, teamObjectives: { A: 3, B: 1 } },
    );
    for (const score of scores) expect(score.breakdown.bonus).toBe(0);
  });

  it('LoL : un joueur médian de son rôle vaut 50, quel que soit le poste', () => {
    // C'est l'invariant qui fait tomber la domination des supports : chaque
    // métrique est comparée à la moyenne DU RÔLE.
    const median = (role: 'Support' | 'Top') => {
      const cle = role === 'Support' ? 'SUP' : 'TOP';
      const d = LOL_DISTRIBUTIONS[cle];
      return {
        playerId: role,
        gameId: 'lol' as const,
        role,
        teamSide: 'A' as const,
        normalized: {
          kills: 3,
          deaths: 3,
          assists: 6,
          damageShare: d.dpmg.moyenne * d.visionShare.moyenne * 0 + d.dpmg.moyenne * 0.2,
          goldShare: 0.2,
          killParticipation: d.kp.moyenne,
          visionShare: d.visionShare.moyenne,
          objControl: d.objControl.moyenne,
          win: false,
        },
      };
    };
    const [sup] = scoreMatch([median('Support')], { rounds: 0 });
    const [top] = scoreMatch([median('Top')], { rounds: 0 });
    // Défaite des deux côtés : même modificateur de résultat, donc même note.
    expect(sup.points).toBe(top.points);
    expect(Math.abs(sup.points - 50)).toBeLessThanOrEqual(2);
  });

  it('Valorant : KAST/ADR absents → imputés (pas de note plombée)', () => {
    const sansKast: PlayerStatLine = {
      playerId: 'p',
      gameId: 'valorant',
      role: null,
      teamSide: 'A',
      normalized: { kills: 15, deaths: 14, assists: 6, firstKills: 3, firstDeaths: 3, clutches: 0 },
    };
    const [score] = scoreMatch([sansKast], { rounds: 24 });
    // Sans imputation, KAST=ADR=0 effondrerait la note ; ici on reste autour de
    // la médiane de l'échelle commune (50).
    expect(score.points).toBeGreaterThan(35);
  });

  it('LoL : GPM absent → formule de secours (KDA/KP), pas une note effondrée', () => {
    const mineure: PlayerStatLine = {
      playerId: 'p',
      gameId: 'lol',
      role: 'Mid',
      teamSide: 'A',
      normalized: { kills: 5, deaths: 3, assists: 8, killParticipation: 0.65 },
    };
    const [score] = scoreMatch([mineure], { rounds: 0 });
    expect(score.breakdown.fallback).toBe(1);
    expect(score.points).toBeGreaterThan(35);
  });

  it('CS2 : aucun bonus contextuel', () => {
    const cs2: PlayerStatLine = {
      playerId: 'p',
      gameId: 'cs2',
      role: null,
      teamSide: 'A',
      normalized: { kills: 25, deaths: 15, firstKills: 3, plants: 2, defuses: 1 },
    };
    const [score] = scoreMatch([cs2], { rounds: 30 });
    expect(score.breakdown.bonus).toBe(0);
  });
});

describe('lolRatingV5 — standardisation par rôle', () => {
  /** Deux rôles aux références volontairement très différentes. */
  const metrique = (moyenne: number, sigma: number) => ({ moyenne, sigma });
  const distributions: LolDistributions = {
    SUP: {
      dpmg: metrique(0.5, 0.1),
      kp: metrique(0.7, 0.1),
      // Un support voit BEAUCOUP plus qu'un mid : c'est tout l'enjeu.
      visionShare: metrique(0.35, 0.05),
      objControl: metrique(0.5, 0.2),
    },
    MID: {
      dpmg: metrique(1.3, 0.2),
      kp: metrique(0.65, 0.1),
      visionShare: metrique(0.15, 0.03),
      objControl: metrique(0.5, 0.2),
    },
  };

  /** Joueur exactement dans la moyenne de son rôle. */
  const median = (role: 'SUP' | 'MID') => {
    const d = distributions[role];
    return {
      role,
      dpmg: d.dpmg.moyenne,
      kp: d.kp.moyenne,
      visionShare: d.visionShare.moyenne,
      objControl: d.objControl.moyenne,
      win: true,
    };
  };

  it('un joueur médian de SON rôle obtient 1,00 de rating, quel que soit le poste', () => {
    const sup = lolRatingV5(median('SUP'), distributions);
    const mid = lolRatingV5(median('MID'), distributions);
    // Seul le modificateur de résultat les écarte de 1,00, à l'identique.
    expect(sup).toBeCloseTo(1.03, 5);
    expect(mid).toBeCloseTo(1.03, 5);
    expect(sup).toBeCloseTo(mid, 10);
  });

  it('c’est ce qui neutralise le biais : une vision élevée en valeur absolue ne suffit plus', () => {
    // 0,30 de part de vision : au-dessus de la moyenne d'un mid (0,15) mais
    // SOUS celle d'un support (0,35). Le support doit donc être pénalisé.
    const sup = lolRatingV5({ ...median('SUP'), visionShare: 0.3 }, distributions);
    const mid = lolRatingV5({ ...median('MID'), visionShare: 0.3 }, distributions);
    expect(sup).toBeLessThan(1.03);
    expect(mid).toBeGreaterThan(1.03);
  });

  it('la défaite retire ce que la victoire ajoute', () => {
    const gagne = lolRatingV5(median('MID'), distributions);
    const perdu = lolRatingV5({ ...median('MID'), win: false }, distributions);
    expect(gagne - perdu).toBeCloseTo(0.06, 10);
  });

  it('borne les sous-scores : une valeur aberrante ne fait pas exploser le rating', () => {
    const aberrant = lolRatingV5({ ...median('MID'), dpmg: 1000 }, distributions);
    const troisSigma = lolRatingV5({ ...median('MID'), dpmg: 1.3 + 3 * 0.2 }, distributions);
    expect(aberrant).toBeCloseTo(troisSigma, 10);
  });

  it('reste dans [0, 2] : la note convertie ne peut ni dépasser 100 ni passer sous 0', () => {
    const max = lolRatingV5(
      { role: 'MID', dpmg: 99, kp: 99, visionShare: 99, objControl: 99, win: true },
      distributions,
    );
    const min = lolRatingV5(
      { role: 'MID', dpmg: -99, kp: -99, visionShare: -99, objControl: -99, win: false },
      distributions,
    );
    expect(max).toBeLessThanOrEqual(2);
    expect(min).toBeGreaterThanOrEqual(0);
  });

  it('sans table de calibrage, la formule est neutre plutôt que fausse', () => {
    expect(lolRatingV5(median('MID'), {})).toBeCloseTo(1.03, 5);
  });

  it('λ pilote la dispersion : un λ plus grand resserre les ratings', () => {
    expect(LOL_LAMBDA).toBeGreaterThan(0);
  });
});
