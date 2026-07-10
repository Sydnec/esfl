import { describe, expect, it } from 'vitest';
import type { MapStatsEntry } from '@esfl/contracts';
import type { Player } from '../../generated/client';
import { championImageUrl, LeaguepediaRow, mapLeaguepediaRows } from './leaguepedia.provider';

const players = [{ id: 'p1', name: 'Caps' }] as Player[];

// Bo3 : Caps joue 3 games pour G2 contre Fnatic (2 victoires).
const rows: LeaguepediaRow[] = [
  {
    Link: 'Caps (Rasmus Winther)',
    Champion: 'Ahri',
    Kills: '5',
    Deaths: '2',
    Assists: '7',
    CS: '280',
    PlayerWin: 'Yes',
    Team: 'G2 Esports',
    Team1: 'G2 Esports',
    Team2: 'Fnatic',
    Gamelength: '30',
    GameNumber: '1',
  },
  {
    Link: 'Caps (Rasmus Winther)',
    Champion: 'Wukong',
    Kills: '2',
    Deaths: '4',
    Assists: '3',
    CS: '250',
    PlayerWin: 'No',
    Team: 'G2 Esports',
    Team1: 'G2 Esports',
    Team2: 'Fnatic',
    Gamelength: '25',
    GameNumber: '2',
  },
  {
    Link: 'Caps (Rasmus Winther)',
    Champion: 'Ahri',
    Kills: '8',
    Deaths: '1',
    Assists: '5',
    CS: '315',
    PlayerWin: 'Yes',
    Team: 'G2 Esports',
    Team1: 'G2 Esports',
    Team2: 'Fnatic',
    Gamelength: '35',
    GameNumber: '3',
  },
  // Un autre match le même jour : doit être filtré.
  {
    Link: 'Autre Joueur',
    Kills: '10',
    Deaths: '0',
    Assists: '2',
    CS: '300',
    PlayerWin: 'Yes',
    Team: 'T1',
    Team1: 'T1',
    Team2: 'Gen.G',
    Gamelength: '28',
  },
];

describe('mapLeaguepediaRows', () => {
  it('filtre par équipes, agrège le Bo3 et gère la désambiguïsation', () => {
    const lines = mapLeaguepediaRows(rows, 'G2 Esports', 'Fnatic', players);
    expect(lines).toHaveLength(1);
    const caps = lines[0];
    expect(caps.playerId).toBe('p1');
    expect(caps.normalized).toMatchObject({
      kills: 15,
      deaths: 7,
      assists: 15,
      win: true,
    });
    // 845 CS sur 90 minutes → 9.39
    expect((caps.normalized as { csPerMin: number }).csPerMin).toBeCloseTo(9.39, 2);
  });

  it('détaille chaque game : champion, KDA, cs/min et résultat', () => {
    const lines = mapLeaguepediaRows(rows, 'G2 Esports', 'Fnatic', players);
    const perMap = lines[0].perMap as MapStatsEntry[];
    expect(perMap).toHaveLength(3);
    expect(perMap[0]).toMatchObject({
      position: 1,
      map: null,
      agent: 'Ahri',
      agentImage: 'https://cdn.communitydragon.org/latest/champion/Ahri/square',
      kills: 5,
      deaths: 2,
      assists: 7,
      win: true,
    });
    expect(perMap[0].csPerMin).toBeCloseTo(9.33, 2);
    expect(perMap[1]).toMatchObject({ position: 2, agent: 'Wukong', win: false });
  });

  it('traduit les noms de champions en ids Data Dragon', () => {
    expect(championImageUrl('Wukong')).toContain('/MonkeyKing/');
    expect(championImageUrl("Kai'Sa")).toContain('/KaiSa/');
    expect(championImageUrl('Renata Glasc')).toContain('/Renata/');
  });

  it('retourne vide si aucune game ne correspond aux équipes', () => {
    expect(mapLeaguepediaRows(rows, 'Karmine Corp', 'Vitality', players)).toHaveLength(0);
  });
});
