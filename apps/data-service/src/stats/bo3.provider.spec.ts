import { describe, expect, it } from 'vitest';
import { bo3TeamMatches, mapBo3GameStats, mapBo3Games, toSlug } from './bo3.provider';

/** Manche bo3 factice. */
function game(
  id: number,
  number: number,
  rounds: number | null,
  over: Record<string, unknown> = {},
) {
  return {
    id,
    number,
    status: rounds ? 'finished' : 'current',
    map_name: `de_map${number}`,
    rounds_count: rounds,
    winner_clan_name: 'Vitality',
    winner_clan_score: 13,
    loser_clan_name: 'NAVI',
    loser_clan_score: 7,
    ...over,
  };
}

/** Ligne `/games/{id}/players_stats` factice (totaux absolus sur une map). */
function statRow(
  gameId: number,
  playerId: number,
  teamId: number,
  nickname: string,
  over: Record<string, unknown> = {},
) {
  return {
    game_id: gameId,
    clan_name: 'Vitality',
    kills: 20,
    death: 14,
    assists: 5,
    adr: 85,
    kast: 0.75,
    damage: 1700,
    headshots: 8,
    first_kills: 2,
    first_death: 1,
    clutches: 1,
    multikills: { '2': 3, '3': 1, '4': 0, '5': 0 },
    player_rating: 7.1,
    win: 1,
    team_clan: { team_id: teamId, team: { id: teamId } },
    steam_profile: {
      nickname: `${nickname}-steam`,
      player_id: playerId,
      player: {
        id: playerId,
        nickname,
        first_name: 'Jean',
        last_name: 'Dupont',
        country: { code: 'FR' },
      },
    },
    ...over,
  };
}

describe('mapBo3GameStats', () => {
  const sideByTeamId = new Map<number, 'A' | 'B'>([
    [10, 'A'],
    [20, 'B'],
  ]);
  const nameByTeamId = new Map<number, string>([
    [10, 'Vitality'],
    [20, 'NAVI'],
  ]);
  const games = new Map([
    [1, game(1, 1, 20)],
    [2, game(2, 2, 30)],
  ]);

  it('remonte les totaux, l’ADR recalculé et le KAST en pourcentage', () => {
    const lines = mapBo3GameStats([statRow(1, 1, 10, 'ZywOo')], games, sideByTeamId, nameByTeamId);
    expect(lines).toHaveLength(1);
    const l = lines[0];
    expect(l.externalName).toBe('ZywOo'); // pseudo pro, pas le pseudo Steam
    expect(l.externalId).toBe('1');
    expect(l.side).toBe('A');
    expect(l.teamName).toBe('Vitality');
    expect(l.realName).toBe('Jean Dupont');
    expect(l.nationality).toBe('FR');
    const n = l.normalized as Record<string, number>;
    expect(n.kills).toBe(20);
    expect(n.adr).toBe(85); // 1700 dégâts / 20 manches
    expect(n.kast).toBe(75);
    expect(n.multiKills).toBe(4); // 3 doublés + 1 triplé
    expect(n.clutches).toBe(1);
  });

  it('cumule les maps : totaux additionnés, ADR pondéré par les manches', () => {
    const lines = mapBo3GameStats(
      [
        statRow(1, 1, 10, 'ZywOo'),
        statRow(2, 1, 10, 'ZywOo', { kills: 10, damage: 1500, adr: 50, kast: 0.5 }),
      ],
      games,
      sideByTeamId,
      nameByTeamId,
    );
    expect(lines).toHaveLength(1);
    const n = lines[0].normalized as Record<string, number>;
    expect(n.kills).toBe(30);
    // 3200 dégâts sur 50 manches : la moyenne des ADR (67,5) serait fausse.
    expect(n.adr).toBe(64);
    // KAST pondéré : (0,75×20 + 0,5×30) / 50 = 60 %.
    expect(n.kast).toBe(60);
    expect((lines[0].perMap as unknown[]).length).toBe(2);
  });

  it('ignore le KAST manquant d’une map en cours sans fausser le cumul', () => {
    const live = new Map([
      [1, game(1, 1, 20)],
      [2, game(2, 2, null)],
    ]);
    const lines = mapBo3GameStats(
      [
        statRow(1, 1, 10, 'ZywOo'),
        // Map en cours : rounds déduits de damage / adr = 10.
        statRow(2, 1, 10, 'ZywOo', { kast: null, damage: 800, adr: 80, kills: 8 }),
      ],
      live,
      sideByTeamId,
      nameByTeamId,
    );
    const n = lines[0].normalized as Record<string, number>;
    expect(n.kills).toBe(28);
    expect(n.kast).toBe(75); // seules les 20 manches à KAST connu comptent
    expect(n.adr).toBe(83.33); // 2500 / 30
  });

  it('résout le côté B et ignore un joueur sans manche jouée', () => {
    const lines = mapBo3GameStats(
      [statRow(1, 2, 20, 'Aleksib'), statRow(1, 3, 20, 'Sub', { damage: 0, adr: 0, game_id: 99 })],
      new Map([[1, game(1, 1, 20)]]),
      sideByTeamId,
      nameByTeamId,
    );
    expect(lines.map((l) => l.externalName)).toEqual(['Aleksib']);
    expect(lines[0].side).toBe('B');
  });

  it('côté null quand l’équipe du joueur n’est pas résolue', () => {
    const [l] = mapBo3GameStats(
      [statRow(1, 4, 99, 'Inconnu')],
      new Map([[1, game(1, 1, 20)]]),
      sideByTeamId,
      nameByTeamId,
    );
    expect(l.side).toBeNull();
  });
});

describe('mapBo3Games', () => {
  const sideByClan = new Map<string, 'A' | 'B'>([
    ['vitality', 'A'],
    ['navi', 'B'],
  ]);

  it('résout les scores par côté et ignore une game sans rounds', () => {
    const games = mapBo3Games(
      [
        {
          id: 1,
          number: 1,
          status: 'finished',
          map_name: 'de_mirage',
          rounds_count: 22,
          winner_clan_name: 'Vitality',
          winner_clan_score: 13,
          loser_clan_name: 'NAVI',
          loser_clan_score: 9,
        },
        {
          id: 2,
          number: 2,
          status: 'upcoming',
          map_name: 'de_nuke',
          rounds_count: 0,
          winner_clan_name: '',
          winner_clan_score: null,
          loser_clan_name: '',
          loser_clan_score: null,
        },
      ],
      sideByClan,
    );
    expect(games).toHaveLength(1);
    // Le vainqueur est côté A, le perdant côté B : les scores atterrissent
    // directement sur le bon côté, sans rapprochement de noms en aval.
    expect(games[0]).toMatchObject({ position: 1, map: 'de_mirage', scoreA: 13, scoreB: 9 });
  });

  it('laisse les scores à null quand le clan n’est rattaché à aucun côté', () => {
    const games = mapBo3Games(
      [
        {
          id: 1,
          number: 1,
          status: 'finished',
          map_name: 'de_mirage',
          rounds_count: 22,
          winner_clan_name: 'Inconnu',
          winner_clan_score: 13,
          loser_clan_name: 'Autre',
          loser_clan_score: 9,
        },
      ],
      sideByClan,
    );
    expect(games[0]).toMatchObject({ scoreA: null, scoreB: null });
  });
});

describe('bo3TeamMatches', () => {
  const eac = { name: 'Esport Academy Copenhagen', acronym: 'EAC', aliases: [] };

  it('rapproche par le nom quand bo3 le donne en entier', () => {
    expect(bo3TeamMatches({ id: 1, name: 'Astralis' }, { name: 'Astralis' })).toBe(true);
  });

  it('rapproche par le slug quand bo3 réduit le nom au tag', () => {
    const ref = { id: 23942, name: 'EAC', slug: 'esport-academy-copenhagen', acronym: 'EAC' };
    expect(bo3TeamMatches(ref, eac)).toBe(true);
  });

  it('rapproche par égalité de tag, sans slug exploitable', () => {
    expect(bo3TeamMatches({ id: 2, name: 'EAC' }, eac)).toBe(true);
  });

  it('ne rapproche pas deux équipes étrangères', () => {
    const ref = { id: 3, name: 'FOKUS', slug: 'fokus-cs', acronym: 'FKS' };
    expect(bo3TeamMatches(ref, eac)).toBe(false);
  });

  it('sans tag local, un nom bo3 abrégé ne suffit pas', () => {
    expect(bo3TeamMatches({ id: 4, name: 'EAC' }, { name: 'Esport Academy Copenhagen' })).toBe(
      false,
    );
  });
});

describe('toSlug', () => {
  it('reproduit la forme des slugs bo3', () => {
    expect(toSlug('Esport Academy Copenhagen')).toBe('esport-academy-copenhagen');
    expect(toSlug('G2 Ares')).toBe('g2-ares');
    expect(toSlug('9z Team')).toBe('9z-team');
  });
});
