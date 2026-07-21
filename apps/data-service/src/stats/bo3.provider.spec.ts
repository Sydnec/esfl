import { describe, expect, it } from 'vitest';
import { bo3TeamMatches, mapBo3Games, mapBo3Stats, toSlug } from './bo3.provider';

/** Ligne de stats bo3 factice (moyennes par round). */
function statRow(
  playerId: number,
  teamId: number,
  nickname: string,
  over: Partial<Record<string, number>> = {},
  player: Record<string, unknown> = {},
) {
  return {
    player_id: playerId,
    rounds_count: 20,
    avg_kills: 1.0,
    avg_death: 0.7,
    avg_assists: 0.25,
    avg_damage: 85,
    avg_player_rating: 7.1,
    avg_first_kills: 0.1,
    avg_first_death: 0.05,
    avg_multikills: 0.2,
    clutches_vs_1: 1,
    clutches_vs_2: 1,
    clutches_vs_3: 0,
    clutches_vs_4: 0,
    clutches_vs_5: 0,
    ...over,
    player: {
      id: playerId,
      nickname,
      first_name: 'Jean',
      last_name: 'Dupont',
      team_id: teamId,
      country: { code: 'FR' },
      ...player,
    },
  };
}

describe('mapBo3Stats', () => {
  const sideByTeamId = new Map<number, 'A' | 'B'>([
    [10, 'A'],
    [20, 'B'],
  ]);
  const nameByTeamId = new Map<number, string>([
    [10, 'Vitality'],
    [20, 'NAVI'],
  ]);

  it('convertit les moyennes par round en totaux et remonte ADR/rating/clutchs', () => {
    const lines = mapBo3Stats([statRow(1, 10, 'ZywOo')], sideByTeamId, nameByTeamId);
    expect(lines).toHaveLength(1);
    const l = lines[0];
    expect(l.externalName).toBe('ZywOo');
    expect(l.externalId).toBe('1');
    expect(l.side).toBe('A');
    expect(l.teamName).toBe('Vitality');
    expect(l.realName).toBe('Jean Dupont');
    expect(l.nationality).toBe('FR');
    const n = l.normalized as Record<string, number>;
    expect(n.kills).toBe(20); // 1.0 × 20
    expect(n.deaths).toBe(14); // 0.7 × 20
    expect(n.adr).toBe(85);
    expect(n.rating).toBe(7.1);
    expect(n.clutches).toBe(2); // 1 + 1
  });

  it('résout le côté B et ignore un joueur à 0 round (remplaçant listé)', () => {
    const lines = mapBo3Stats(
      [statRow(2, 20, 'Aleksib'), statRow(3, 20, 'Sub', { rounds_count: 0 })],
      sideByTeamId,
      nameByTeamId,
    );
    expect(lines.map((l) => l.externalName)).toEqual(['Aleksib']);
    expect(lines[0].side).toBe('B');
  });

  it('côté null quand l’équipe du joueur n’est pas résolue', () => {
    const [l] = mapBo3Stats([statRow(4, 99, 'Inconnu')], sideByTeamId, nameByTeamId);
    expect(l.side).toBeNull();
  });
});

describe('mapBo3Games', () => {
  it('mappe map/scores par clan et ignore une game sans rounds', () => {
    const games = mapBo3Games([
      {
        id: 1,
        number: 1,
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
        map_name: 'de_nuke',
        rounds_count: 0,
        winner_clan_name: '',
        winner_clan_score: null,
        loser_clan_name: '',
        loser_clan_score: null,
      },
    ]);
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({ position: 1, map: 'de_mirage' });
    expect(games[0].teams).toEqual([
      { name: 'Vitality', score: 13 },
      { name: 'NAVI', score: 9 },
    ]);
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
