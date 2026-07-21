import { describe, expect, it } from 'vitest';
import {
  canonicalLolRole,
  cs2BaseNote,
  lolBaseNote,
  mapsPlayed,
  PlayerStatLine,
  roundsPlayed,
  scoreMatch,
  valorantBaseNote,
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

describe('formules de base — ancrages (~70 solide, ~85 MVP)', () => {
  it('Valorant : joueur moyen ≈ 70, MVP ≈ 85', () => {
    const moyen = valorantBaseNote({ kpr: 0.68, apr: 0.25, dpr: 0.66, adr: 130, kast: 72 });
    expect(moyen).toBeGreaterThan(66);
    expect(moyen).toBeLessThan(74);
    expect(valorantBaseNote({ kpr: 0.95, apr: 0.3, dpr: 0.55, adr: 175, kast: 80 })).toBeGreaterThan(82);
  });

  it('CS2 (HLTV, ADR via bo3) : joueur moyen ≈ 70', () => {
    // Moyen : KPR 0.68, DPR 0.68, ADR 80, KAST 70 (imputé).
    const note = cs2BaseNote({ kpr: 0.68, dpr: 0.68, adr: 80, kast: 70 });
    expect(note).toBeGreaterThan(60);
    expect(note).toBeLessThan(78);
  });

  it('LoL : joueur solide entre 70 et 85 (KDA 3, KP 64, GPM 400, VSM 1.9)', () => {
    const note = lolBaseNote({ kda: 3, kp: 64, gpm: 400, vsm: 1.9 });
    expect(note).toBeGreaterThan(70);
    expect(note).toBeLessThan(85);
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

  it('LoL : Support +8, +2 si control wards > 3 ; Jungler +2 par objectif d’équipe', () => {
    const scores = scoreMatch(
      [
        lol('sup', 'Support', 'A', { controlWards: 5 }),
        lol('jgl', 'Jungle', 'A', {}),
        lol('mid', 'Mid', 'B', {}),
      ],
      { rounds: 0, teamObjectives: { A: 3, B: 1 } },
    );
    const byId = Object.fromEntries(scores.map((s) => [s.playerId, s.breakdown]));
    expect(byId['sup'].bonusSupport).toBe(8);
    expect(byId['sup'].bonusWards).toBe(2);
    expect(byId['jgl'].bonusObjectives).toBe(6);
    expect(byId['mid'].bonus).toBe(0);
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
    // Sans imputation, KAST=ADR=0 donnerait une note très basse ; ici ~moyenne.
    expect(score.points).toBeGreaterThan(55);
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
    expect(score.points).toBeGreaterThan(60);
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
