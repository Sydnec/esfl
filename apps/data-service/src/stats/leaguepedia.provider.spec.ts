import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { MapStatsEntry } from '@esfl/contracts';
import type { Match } from '../../generated/client';
import { politeFetch } from './polite-fetch';
import {
  championImageUrl,
  LeaguepediaRow,
  LeaguepediaStatsProvider,
  leaguepediaTeamNames,
  mapLeaguepediaRows,
  parseLeaguepediaRoster,
} from './leaguepedia.provider';
import type { MatchContext } from './provider';

describe('leaguepediaTeamNames', () => {
  it('rend le nom canonique de chaque équipe par côté', () => {
    const rows: LeaguepediaRow[] = [{ Team1: 'T1', Team2: 'Gen.G Esports' }];
    expect(leaguepediaTeamNames(rows, { name: 'T1' }, { name: 'Gen.G' })).toEqual({
      A: 'T1',
      B: 'Gen.G Esports',
    });
  });
});

describe('parseLeaguepediaRoster', () => {
  it('garde les joueurs actifs, exclut retraités, remplaçants et coachs', () => {
    const starters = parseLeaguepediaRoster([
      { ID: 'Doran', Role: 'Top', IsRetired: '', IsSubstitute: '' },
      { ID: 'Oner', Role: 'Jungle' },
      { ID: 'Faker', Role: 'Mid' },
      { ID: 'Gumayusi', Role: 'Bot' },
      { ID: 'Keria', Role: 'Support' },
      { ID: 'Poby', Role: 'Bot', IsSubstitute: '1' },
      { ID: 'OldMid', Role: 'Mid', IsRetired: '1' },
      { ID: 'Tom', Role: 'Coach' },
    ]);
    expect(starters.map((s) => s.name)).toEqual(['Doran', 'Oner', 'Faker', 'Gumayusi', 'Keria']);
  });
});

vi.mock('./polite-fetch', () => ({ politeFetch: vi.fn() }));

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

describe('mapLeaguepediaRows — KP%, damageShare, visionScore', () => {
  it('calcule les ratios via les totaux d’équipe par game', () => {
    const game: LeaguepediaRow[] = [
      { Link: 'Caps', Kills: '5', Deaths: '2', Assists: '7', Team: 'G2 Esports', Team1: 'G2 Esports', Team2: 'Fnatic', GameId: 'g1', DamageToChampions: '20000', VisionScore: '30' },
      { Link: 'Jankos', Kills: '3', Deaths: '1', Assists: '10', Team: 'G2 Esports', Team1: 'G2 Esports', Team2: 'Fnatic', GameId: 'g1', DamageToChampions: '10000', VisionScore: '50' },
    ];
    const caps = mapLeaguepediaRows(game, { name: 'G2 Esports' }, { name: 'Fnatic' }).find(
      (line) => line.externalName === 'Caps',
    );
    // KP = (5+7)/(5+3) = 1.5 ; part de dégâts = 20000/30000 = 0.667 ; vision = 30.
    expect(caps?.normalized).toMatchObject({
      killParticipation: 1.5,
      damageShare: 0.667,
      visionScore: 30,
    });
  });
});

describe('mapLeaguepediaRows', () => {
  it('filtre par équipes, agrège le Bo3, résout le côté et la désambiguïsation', () => {
    const lines = mapLeaguepediaRows(rows, { name: 'G2 Esports' }, { name: 'Fnatic' });
    expect(lines).toHaveLength(1);
    const caps = lines[0];
    expect(caps.externalName).toBe('Caps');
    expect(caps.side).toBe('A');
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
    const lines = mapLeaguepediaRows(rows, { name: 'G2 Esports' }, { name: 'Fnatic' });
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
    expect(mapLeaguepediaRows(rows, { name: 'Karmine Corp' }, { name: 'Vitality' })).toHaveLength(0);
  });
});

describe('LeaguepediaStatsProvider — cache de fenêtre', () => {
  const mockedFetch = vi.mocked(politeFetch);

  beforeEach(() => {
    mockedFetch.mockReset();
    // 3 rows (< 500) → une seule page par fenêtre.
    mockedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ cargoquery: rows.slice(0, 3).map((title) => ({ title })) }),
    } as Response);
  });

  const context = {
    teamA: { name: 'G2 Esports', aliases: [] },
    teamB: { name: 'Fnatic', aliases: [] },
    players: [],
  } as unknown as MatchContext;
  const matchAt = (iso: string) => ({ id: 'm', beginAt: new Date(iso), scheduledAt: null }) as Match;
  // Sans identifiants configurés → accès anonyme (pas de login supplémentaire).
  const configMock = { get: () => undefined } as unknown as ConfigService;
  const makeProvider = () => new LeaguepediaStatsProvider(configMock);

  it('mutualise la requête entre matchs d’un même bucket de 3h', async () => {
    const provider = makeProvider();
    // 01:00 et 02:00 UTC tombent dans le même bucket [00:00, 03:00).
    await provider.fetchStats(matchAt('2026-07-10T01:00:00Z'), context);
    await provider.fetchStats(matchAt('2026-07-10T02:00:00Z'), context);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('refait une requête pour un autre bucket', async () => {
    const provider = makeProvider();
    await provider.fetchStats(matchAt('2026-07-10T01:00:00Z'), context);
    await provider.fetchStats(matchAt('2026-07-10T04:00:00Z'), context);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('ne met pas en cache un échec réseau (retry possible)', async () => {
    const provider = makeProvider();
    mockedFetch.mockResolvedValueOnce({ ok: false, status: 429 } as Response);
    const first = await provider.fetchStats(matchAt('2026-07-10T01:00:00Z'), context);
    expect(first).toBeNull();
    // Deuxième essai même bucket : nouvelle requête (le null n'a pas été caché).
    await provider.fetchStats(matchAt('2026-07-10T01:00:00Z'), context);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
});
