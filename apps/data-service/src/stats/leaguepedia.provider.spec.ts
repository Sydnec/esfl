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
  mapLeaguepediaGames,
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

  it('remonte photo (Special:Filepath) et pays (ISO2) quand la page les a', () => {
    const [canna] = parseLeaguepediaRoster([
      { ID: 'Canna', Role: 'Top', Image: 'Canna 2026.png', Country: 'South Korea' },
    ]);
    expect(canna).toMatchObject({
      name: 'Canna',
      imageUrl: 'https://lol.fandom.com/wiki/Special:Filepath/Canna%202026.png',
      nationality: 'KR',
    });
    const [inconnu] = parseLeaguepediaRoster([{ ID: 'Mystery', Role: 'Mid' }]);
    expect(inconnu).toMatchObject({ imageUrl: null, nationality: null });
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
      { Link: 'Caps', Kills: '5', Deaths: '2', Assists: '7', Team: 'G2 Esports', Team1: 'G2 Esports', Team2: 'Fnatic', GameId: 'g1', DamageToChampions: '20000', VisionScore: '30', Gold: '12000' },
      { Link: 'Jankos', Kills: '3', Deaths: '1', Assists: '10', Team: 'G2 Esports', Team1: 'G2 Esports', Team2: 'Fnatic', GameId: 'g1', DamageToChampions: '10000', VisionScore: '50', Gold: '8000' },
    ];
    const caps = mapLeaguepediaRows(game, { name: 'G2 Esports' }, { name: 'Fnatic' }).find(
      (line) => line.externalName === 'Caps',
    );
    // KP = (5+7)/(5+3) = 1.5 ; part de dégâts = 20000/30000 = 0.667 ; vision = 30 ;
    // part d'or = 12000/20000 = 0.6.
    expect(caps?.normalized).toMatchObject({
      killParticipation: 1.5,
      damageShare: 0.667,
      visionScore: 30,
      goldShare: 0.6,
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
    // Variantes par minute (une game longue gonfle les compteurs bruts) :
    // 15 kills / 90 min = 0.17, 7 morts / 90 min = 0.08.
    const normalized = caps.normalized as Record<string, number>;
    expect(normalized.killsPerMin).toBeCloseTo(0.17, 2);
    expect(normalized.deathsPerMin).toBeCloseTo(0.08, 2);
    expect(normalized.durationMinutes).toBe(90);
  });

  it('remonte le rôle joué sur le match (SP.Role)', () => {
    const withRoles = rows.map((row) => ({ ...row, Role: 'Mid' }));
    const [caps] = mapLeaguepediaRows(withRoles, { name: 'G2 Esports' }, { name: 'Fnatic' });
    expect(caps.role).toBe('Mid');
  });

  it('rôles divergents entre games : le dernier non-vide gagne (swap en cours de série)', () => {
    const swapped: LeaguepediaRow[] = [
      { ...rows[0], Role: 'Mid' },
      { ...rows[1], Role: '' },
      { ...rows[2], Role: 'Bot' },
    ];
    const [caps] = mapLeaguepediaRows(swapped, { name: 'G2 Esports' }, { name: 'Fnatic' });
    expect(caps.role).toBe('Bot');
  });

  it('rôle absent des lignes : role null', () => {
    const [caps] = mapLeaguepediaRows(rows, { name: 'G2 Esports' }, { name: 'Fnatic' });
    expect(caps.role).toBeNull();
  });

  it('le canonique vient des lignes du match, pas du reste de la fenêtre (T1 vs T1.EA)', () => {
    const windowRows: LeaguepediaRow[] = [
      // Game de l'académie dans la même fenêtre : « T1 » y matche « T1.EA »
      // par inclusion, mais elle ne doit pas fournir le canonique.
      { Link: 'Acad', Team: 'T1.EA', Team1: 'T1.EA', Team2: 'BRO Challengers', GameId: 'a1' },
      { Link: 'Faker', Team: 'T1', Team1: 'T1', Team2: 'Gen.G', GameId: 'g1', Kills: '3' },
    ];
    expect(leaguepediaTeamNames(windowRows, { name: 'T1' }, { name: 'Gen.G' })).toEqual({
      A: 'T1',
      B: 'Gen.G',
    });
  });

  it('expose la durée de chaque game (lengthSec) pour l’affichage', () => {
    const games = mapLeaguepediaGames(rows, { name: 'G2 Esports' }, { name: 'Fnatic' });
    expect(games.map((game) => game.lengthSec)).toEqual([1800, 1500, 2100]);
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

  it('détaille les ratios d’équipe par game (vue avancée d’une game précise)', () => {
    const game: LeaguepediaRow[] = [
      { Link: 'Caps', Kills: '5', Assists: '7', Team: 'G2 Esports', Team1: 'G2 Esports', Team2: 'Fnatic', GameId: 'g1', GameNumber: '1', DamageToChampions: '20000', VisionScore: '30', Gold: '12000' },
      { Link: 'Jankos', Kills: '3', Assists: '10', Team: 'G2 Esports', Team1: 'G2 Esports', Team2: 'Fnatic', GameId: 'g1', GameNumber: '1', DamageToChampions: '10000', VisionScore: '50', Gold: '8000' },
    ];
    const caps = mapLeaguepediaRows(game, { name: 'G2 Esports' }, { name: 'Fnatic' }).find(
      (line) => line.externalName === 'Caps',
    );
    const entry = (caps?.perMap as MapStatsEntry[])[0];
    expect(entry).toMatchObject({
      killParticipation: 1.5,
      damageShare: 0.667,
      goldShare: 0.6,
      visionScore: 30,
    });
  });

  it('traduit les noms de champions en ids Data Dragon', () => {
    expect(championImageUrl('Wukong')).toContain('/MonkeyKing/');
    expect(championImageUrl("Kai'Sa")).toContain('/KaiSa/');
    expect(championImageUrl('Renata Glasc')).toContain('/Renata/');
  });

  it('retourne vide si aucune game ne correspond aux équipes', () => {
    expect(mapLeaguepediaRows(rows, { name: 'Karmine Corp' }, { name: 'Vitality' })).toHaveLength(0);
  });

  it('exclut la game d’une équipe dérivée (matching strict, pas de sous-chaîne)', () => {
    // La fenêtre ±12h contient aussi une game des académies. « G2 Esports
    // Academy » contient « G2 Esports » : l'ancienne inclusion floue fusionnait
    // les deux rosters (match à 20 joueurs). L'égalité stricte l'écarte.
    const withAcademy: LeaguepediaRow[] = [
      ...rows,
      {
        Link: 'Sub Académie (X)',
        Kills: '9',
        Deaths: '1',
        Assists: '4',
        CS: '260',
        PlayerWin: 'Yes',
        Team: 'G2 Esports Academy',
        Team1: 'G2 Esports Academy',
        Team2: 'Fnatic Academy',
        Gamelength: '30',
      },
    ];
    const lines = mapLeaguepediaRows(withAcademy, { name: 'G2 Esports' }, { name: 'Fnatic' });
    expect(lines.map((line) => line.externalName)).not.toContain('Sub Académie');
    // Seuls les joueurs de la vraie rencontre G2 vs Fnatic subsistent.
    expect(lines.every((line) => line.side === 'A' || line.side === 'B')).toBe(true);
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
