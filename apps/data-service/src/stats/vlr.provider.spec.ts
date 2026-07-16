import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapStatsEntry } from '@esfl/contracts';
import {
  mapVlrGames,
  mapVlrMatchHtml,
  parseVlrMatchListing,
  parseVlrMatchTeamIds,
  parseVlrPerformance,
  parseVlrPerformanceViews,
  parseVlrRoster,
  parseVlrTeamMatches,
  parseVlrTeamProfile,
  parseVlrTeamSearch,
  pickVlrTeamHistoryMatch,
  vlrListingEntryMatches,
  VlrStatsProvider,
} from './vlr.provider';
import { politeFetch } from './polite-fetch';

vi.mock('./polite-fetch', () => ({ politeFetch: vi.fn() }));

describe('parseVlrMatchTeamIds', () => {
  const html =
    '<a class="match-header-link mod-1" href="/team/13576/jdg-esports"></a>' +
    '<a class="match-header-link mod-2" href="/team/11328/funplus-phoenix"></a>' +
    '<div class="vm-stats-game-header">' +
    '<div class="team-name">JDG Esports</div><div class="team-name">FunPlus Phoenix</div></div>';

  it('rattache les ids VLR au bon côté selon le header', () => {
    expect(
      parseVlrMatchTeamIds(html, { name: 'JDG Esports' }, { name: 'FunPlus Phoenix' }),
    ).toEqual({ A: '13576', B: '11328' });
    // Côtés inversés : l'équipe de gauche devient B.
    expect(
      parseVlrMatchTeamIds(html, { name: 'FunPlus Phoenix' }, { name: 'JDG Esports' }),
    ).toEqual({ A: '11328', B: '13576' });
  });

  it('renvoie undefined si le côté gauche n’est pas reconnu', () => {
    expect(parseVlrMatchTeamIds(html, { name: 'Inconnu' }, { name: 'Autre' })).toBeUndefined();
  });
});

/** Item de roster VLR : `role` vide = titulaire ; sinon remplaçant/staff. */
const rosterItem = (alias: string, role = '', id = '1') =>
  `<div class="team-roster-item"><a href="/player/${id}/${alias}" style="display:flex;">` +
  `<div class="team-roster-item-name"><div class="team-roster-item-name-alias">` +
  `<i class="flag mod-gb"></i>${alias}</div>` +
  (role ? `<div class="team-roster-item-name-role">${role}</div>` : '') +
  `</div></a></div>`;

describe('parseVlrRoster', () => {
  it('ne garde que les joueurs sans rôle (exclut sub et staff), avec leur id VLR', () => {
    const html =
      rosterItem('musashi', '', '7857') +
      rosterItem('azury', '', '42') +
      rosterItem('Fizzy') +
      rosterItem('MONSTEERR') +
      rosterItem('Jamelinho') +
      rosterItem('kendo', 'sub') +
      rosterItem('Sebe', 'head coach');
    const starters = parseVlrRoster(html);
    expect(starters.map((s) => s.name)).toEqual([
      'musashi',
      'azury',
      'Fizzy',
      'MONSTEERR',
      'Jamelinho',
    ]);
    expect(starters[0]).toEqual({ name: 'musashi', externalId: '7857' });
    expect(starters[1].externalId).toBe('42');
  });
});

describe('parseVlrTeamSearch', () => {
  it('extrait id + nom des résultats équipe', () => {
    const html =
      '<a href="/search/r/team/20697/idx" class="wf-module-item search-item mod-first">' +
      '<div class="search-item-title">FUT Esports</div></a>' +
      '<a href="/search/r/team/1184/idx" class="wf-module-item search-item">' +
      '<div class="search-item-title">FUT Academy</div></a>';
    expect(parseVlrTeamSearch(html)).toEqual([
      { id: '20697', name: 'FUT Esports' },
      { id: '1184', name: 'FUT Academy' },
    ]);
  });
});

const teamProfileHtml = (name: string, tag: string, logo: string) =>
  `<div class="team-header">` +
  `<div class="wf-avatar team-header-logo"><img src="${logo}"></div>` +
  `<div class="team-header-desc"><div class="team-header-name">` +
  `<h1 class="wf-title">${name}</h1><h2 class="wf-title team-header-tag">${tag}</h2></div>` +
  `<div class="team-header-country"><i class="flag mod-br"></i> Brazil</div></div></div>` +
  rosterItem('aspas', '', '10646');

describe('parseVlrTeamProfile', () => {
  it('extrait nom, tag, logo, pays (code drapeau) et roster', () => {
    const profile = parseVlrTeamProfile(
      teamProfileHtml('LOUD', 'LLL', '//owcdn.net/img/loud.png'),
    );
    expect(profile).toEqual({
      name: 'LOUD',
      acronym: 'LLL',
      imageUrl: 'https://owcdn.net/img/loud.png',
      location: 'BR',
      roster: [{ name: 'aspas', externalId: '10646' }],
    });
  });

  it('logo placeholder VLR → pas de logo revendiqué ; page sans en-tête → null', () => {
    const profile = parseVlrTeamProfile(teamProfileHtml('LOUD', 'LLL', '/img/vlr/tmp/vlr.png'));
    expect(profile?.imageUrl).toBeNull();
    expect(parseVlrTeamProfile('<div>rien</div>')).toBeNull();
  });
});

describe('mapVlrGames', () => {
  const header = (map: string, scoreA: number | string, scoreB: number | string) =>
    `<div class="vm-stats-game-header"><div class="map">${map}</div>` +
    `<div class="team-name">NRG</div><div class="score">${scoreA}</div>` +
    `<div class="team-name">100 Thieves</div><div class="score">${scoreB}</div></div>`;

  it('ignore les maps 0-0 jamais jouées (game 3 d’un BO3 plié en 2-0)', () => {
    const games = mapVlrGames(header('Ascent', 13, 9) + header('Bind', 13, 11) + header('Haven', 0, 0));
    expect(games.map((game) => game.map)).toEqual(['Ascent', 'Bind']);
  });
});

const listingCard = (href: string, names: [string, string], scores?: [number, number]) =>
  `<a href="${href}" class="wf-module-item match-item">` +
  names
    .map(
      (name, index) =>
        `<div class="match-item-vs-team"><div class="match-item-vs-team-name">${name}</div>` +
        (scores ? `<div class="match-item-vs-team-score">${scores[index]}</div>` : '') +
        `</div>`,
    )
    .join('') +
  `</a>`;

// Même matchup joué deux jours différents avec des scores différents : le cas
// NRG vs 100T répété qui polluait l'ingestion historique.
const listingHtml =
  `<div class="wf-label mod-large">Sat, July 12, 2026 <span>Today</span></div>` +
  `<div class="wf-card">${listingCard('/1001/nrg-vs-100t', ['NRG', '100 Thieves'], [2, 1])}</div>` +
  `<div class="wf-label mod-large">Tue, July 8, 2026</div>` +
  `<div class="wf-card">${listingCard('/0900/nrg-vs-100t', ['NRG', '100 Thieves'], [0, 2])}</div>`;

describe('parseVlrMatchListing / vlrListingEntryMatches', () => {
  const teamA = { name: 'NRG' };
  const teamB = { name: '100 Thieves' };

  it('associe chaque affiche au jour de son groupe et à ses scores', () => {
    const entries = parseVlrMatchListing(listingHtml);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ href: '/1001/nrg-vs-100t', scores: [2, 1] });
    expect(entries[0].date?.toDateString()).toBe(new Date('2026-07-12').toDateString());
    expect(entries[1].date?.toDateString()).toBe(new Date('2026-07-08').toDateString());
  });

  it('discrimine un matchup répété par la date', () => {
    const entries = parseVlrMatchListing(listingHtml);
    const old = { reference: new Date('2026-07-08T18:00:00Z') };
    expect(vlrListingEntryMatches(entries[0], teamA, teamB, old)).toBe(false);
    expect(vlrListingEntryMatches(entries[1], teamA, teamB, old)).toBe(true);
  });

  it('discrimine par le score global (orientation respectée)', () => {
    const entries = parseVlrMatchListing(listingHtml);
    expect(vlrListingEntryMatches(entries[0], teamA, teamB, { scoreA: 2, scoreB: 1 })).toBe(true);
    expect(vlrListingEntryMatches(entries[0], teamA, teamB, { scoreA: 0, scoreB: 2 })).toBe(false);
    // Équipes inversées chez nous : 100T=A, NRG=B → score attendu retourné.
    expect(vlrListingEntryMatches(entries[0], teamB, teamA, { scoreA: 1, scoreB: 2 })).toBe(true);
  });

  it('sans critère exploitable, dégrade vers le matching par noms', () => {
    const noDate = parseVlrMatchListing(listingCard('/1/x-vs-y', ['NRG', '100 Thieves']));
    expect(
      vlrListingEntryMatches(noDate[0], teamA, teamB, {
        reference: new Date('2026-01-01'),
        scoreA: 2,
        scoreB: 1,
      }),
    ).toBe(true);
  });
});

const historyItem = (
  href: string,
  self: string,
  opponent: string,
  score: string,
  date: string,
) =>
  `<a href="${href}" class="wf-card fc-flex m-item">` +
  `<div class="m-item-team"><div class="m-item-team-name">${self}</div></div>` +
  `<div class="m-item-result"><span>${score.split(':')[0]}</span>:<span>${score.split(':')[1]}</span></div>` +
  `<div class="m-item-team mod-right"><div class="m-item-team-name">${opponent}</div></div>` +
  `<div class="m-item-date">${date} 2:00 am</div>` +
  `</a>` +
  // Sous-carte par map : à ignorer (classe m-item-games-item).
  `<a href="${href}/?game=1" class="wf-card m-item m-item-games-item"><div class="m-item-team-name">bruit</div></a>`;

describe('historique de matchs d’équipe VLR (matchs anciens)', () => {
  // NRG vs 100T joué deux fois : seule la date/le score départagent.
  const html =
    historyItem('/1001/nrg-vs-100t', 'NRG', '100 Thieves', '2:1', '2026/07/12') +
    historyItem('/0900/nrg-vs-100t', 'NRG', '100 Thieves', '0:2', '2026/03/08') +
    historyItem('/0800/nrg-vs-sen', 'NRG', 'Sentinels', '2:0', '2026/03/01');

  it('parse href, noms, score orienté et jour (sous-cartes par map ignorées)', () => {
    const items = parseVlrTeamMatches(html);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      href: '/1001/nrg-vs-100t',
      names: ['NRG', '100 Thieves'],
      scores: [2, 1],
    });
    expect(items[1].date?.toISOString().slice(0, 10)).toBe('2026-03-08');
  });

  it('retrouve le bon match d’un matchup répété par la date et le score', () => {
    const items = parseVlrTeamMatches(html);
    expect(
      pickVlrTeamHistoryMatch(items, { name: '100 Thieves' }, {
        reference: new Date('2026-03-08T18:00:00Z'),
        ownScore: 0,
        oppScore: 2,
      }),
    ).toBe('/0900/nrg-vs-100t');
    // Score contradictoire → rien (pas de best guess).
    expect(
      pickVlrTeamHistoryMatch(items, { name: '100 Thieves' }, {
        reference: new Date('2026-03-08T18:00:00Z'),
        ownScore: 2,
        oppScore: 0,
      }),
    ).toBeNull();
    // Date hors tolérance → rien.
    expect(
      pickVlrTeamHistoryMatch(items, { name: 'Sentinels' }, {
        reference: new Date('2026-06-01T18:00:00Z'),
      }),
    ).toBeNull();
  });
});

describe('searchTeam (recherche proactive stricte)', () => {
  const searchHtml = (teams: Array<{ id: string; name: string }>) =>
    teams
      .map(
        (team) =>
          `<a href="/search/r/team/${team.id}/idx" class="search-item">` +
          `<div class="search-item-title">${team.name}</div></a>`,
      )
      .join('');
  const provider = new VlrStatsProvider();
  const mockSearch = (teams: Array<{ id: string; name: string }>) => {
    vi.mocked(politeFetch).mockResolvedValue({
      ok: true,
      text: async () => searchHtml(teams),
    } as Response);
  };

  beforeEach(() => vi.mocked(politeFetch).mockReset());

  it('accepte la correspondance exacte unique', async () => {
    mockSearch([
      { id: '20697', name: 'FUT Esports' },
      { id: '1184', name: 'FUT Academy' },
    ]);
    expect(await provider.searchTeam('FUT Esports', [])).toEqual({
      id: '20697',
      name: 'FUT Esports',
    });
  });

  it('nom proche sans tag pour confirmer → null', async () => {
    mockSearch([
      { id: '2', name: 'NAVI Junior' },
      { id: '9', name: 'Autre Structure' },
    ]);
    expect(await provider.searchTeam('NAVI Junior BR', [])).toBeNull();
  });

  it('nom proche confirmé par un tag EXACTEMENT identique', async () => {
    // 1er fetch : la recherche ; 2e : la page du candidat (tag NJR).
    vi.mocked(politeFetch)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => searchHtml([{ id: '2', name: 'NAVI Junior' }]),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => teamProfileHtml('NAVI Junior', 'NJR', '//owcdn.net/img/njr.png'),
      } as Response);
    expect(await provider.searchTeam('NAVI Junior BR', [], 'NJR')).toEqual({
      id: '2',
      name: 'NAVI Junior',
    });
  });

  it('nom proche avec tag différent → null (jamais de best guess)', async () => {
    vi.mocked(politeFetch)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => searchHtml([{ id: '2', name: 'NAVI Junior' }]),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => teamProfileHtml('NAVI Junior', 'NJR', '//owcdn.net/img/njr.png'),
      } as Response);
    expect(await provider.searchTeam('NAVI Junior BR', [], 'NAVI')).toBeNull();
  });

  it('aucun résultat → null', async () => {
    mockSearch([]);
    expect(await provider.searchTeam('Équipe Fantôme', [])).toBeNull();
  });
});

// Reproduit la grille .ovw-table de vlr.gg (une table par équipe). Ordre des
// valeurs : R, ACS, K, D, A, +/-, KAST, ADR, HS%, FK, FD, +/-.
const cell = (value: number | string) =>
  `<div class="ovw-cell"><span class="side mod-both">${value}</span></div>`;

const kdaCell = (k: number | string, d: number | string, a: number | string) =>
  `<div class="ovw-cell mod-kda">` +
  `<span class="ovw-kda-stat" data-col="kills"><span class="side mod-both">${k}</span></span>/` +
  `<span class="ovw-kda-stat" data-col="deaths"><span class="side mod-both">${d}</span></span>/` +
  `<span class="ovw-kda-stat" data-col="assists"><span class="side mod-both">${a}</span></span>` +
  `</div>`;

function statRow(name: string, tag: string, agent: string | null, v: Array<number | string>): string {
  const agentHtml = agent
    ? `<div class="ovw-agents"><span class="mod-agent"><img title="${agent}" alt="${agent}" src="/img/vlr/game/agents/${agent.toLowerCase()}.png"></span></div>`
    : '';
  return `
    <div class="ovw-row">
      <div class="ovw-cell mod-player">
        <div class="ovw-player"><a><div class="ovw-player-name text-of">${name}</div><div class="ovw-player-tag">${tag}</div></a></div>
        ${agentHtml}
      </div>
      ${cell(v[0])}${cell(v[1])}${kdaCell(v[2], v[3], v[4])}${cell(v[5])}${cell(v[6])}${cell(v[7])}${cell(v[8])}${cell(v[9])}${cell(v[10])}${cell(v[11])}
    </div>`;
}

const emptyRow = (name: string, tag: string, agent: string | null) =>
  statRow(name, tag, agent, Array.from({ length: 12 }, () => '&nbsp;'));

const head = `
  <div class="ovw-row mod-head">
    <div class="ovw-th"></div><div class="ovw-th">R</div><div class="ovw-th">ACS</div>
    <div class="ovw-th mod-kda">K/D/A</div><div class="ovw-th">+/–</div><div class="ovw-th">KAST</div>
    <div class="ovw-th">ADR</div><div class="ovw-th">HS%</div><div class="ovw-th">FK</div>
    <div class="ovw-th">FD</div><div class="ovw-th">+/–</div>
  </div>`;

const ovwTable = (rows: string) => `<div class="ovw-table">${head}${rows}</div>`;

const mapHeader = (mapName: string, scoreL: number, scoreR: number) => `
  <div class="vm-stats-game-header">
    <div class="team"><div class="score">${scoreL}</div><div class="team-name">Sentinels</div></div>
    <div class="map"><span>${mapName}</span></div>
    <div class="team mod-right"><div class="score">${scoreR}</div><div class="team-name">Fnatic</div></div>
  </div>`;

// Bloc agrégé « all » : une table Sentinels (gauche), une table Fnatic (droite),
// + deux blocs par manche avec en-tête (map, scores) et colonne agent.
const html = `
<div class="vm-stats-game" data-game-id="all">
  ${ovwTable(
    statRow('TenZ', 'SEN', null, [1.24, 255, 42, 30, 8, 12, 74, 160, 28, 6, 3, 3]) +
      statRow('NouveauSentinel', 'SEN', null, [0.9, 180, 25, 32, 10, -7, 60, 120, 20, 2, 5, -3]),
  )}
  ${ovwTable(statRow('Boaster', 'FNC', null, [1.02, 200, 30, 31, 12, -1, 68, 130, 22, 3, 4, -1]))}
</div>
<div class="vm-stats-game" data-game-id="171001">
  ${mapHeader('Ascent\nPICK', 13, 7)}
  ${ovwTable(statRow('TenZ', 'SEN', 'Jett', [1.4, 270, 25, 14, 3, 11, 78, 170, 30, 4, 1, 3]))}
</div>
<div class="vm-stats-game" data-game-id="171002">
  ${mapHeader('Bind', 10, 13)}
  ${ovwTable(statRow('TenZ', 'SEN', 'Omen', [1.1, 240, 17, 16, 5, 1, 70, 150, 26, 2, 2, 0]))}
</div>`;

describe('mapVlrMatchHtml', () => {
  it('extrait toutes les lignes avec pseudo et côté A/B résolu par tag d’équipe', () => {
    const lines = mapVlrMatchHtml(html, { name: 'Sentinels' }, { name: 'Fnatic' });
    expect(lines).toHaveLength(3);
    const tenz = lines.find((line) => line.externalName === 'TenZ');
    expect(tenz?.side).toBe('A');
    expect(tenz?.normalized).toEqual({
      kills: 42,
      deaths: 30,
      assists: 8,
      acs: 255,
      firstKills: 6,
      rating: 1.24,
      kast: 74,
      adr: 160,
      hsPercent: 28,
      firstDeaths: 3,
    });
    // Joueur inconnu du référentiel : quand même extrait, avec son côté.
    expect(lines.find((line) => line.externalName === 'NouveauSentinel')?.side).toBe('A');
    expect(lines.find((line) => line.externalName === 'Boaster')?.side).toBe('B');
  });

  it('résout le côté avec les équipes inversées (droite = A)', () => {
    const lines = mapVlrMatchHtml(html, { name: 'Fnatic' }, { name: 'Sentinels' });
    expect(lines.find((line) => line.externalName === 'TenZ')?.side).toBe('B');
    expect(lines.find((line) => line.externalName === 'Boaster')?.side).toBe('A');
  });

  it('extrait le détail par manche avec agent et nom de map', () => {
    const lines = mapVlrMatchHtml(html, { name: 'Sentinels' }, { name: 'Fnatic' });
    const perMap = lines.find((line) => line.externalName === 'TenZ')?.perMap as MapStatsEntry[];
    expect(perMap).toHaveLength(2);
    expect(perMap[0]).toEqual({
      position: 1,
      map: 'Ascent',
      agent: 'Jett',
      agentImage: 'https://www.vlr.gg/img/vlr/game/agents/jett.png',
      kills: 25,
      deaths: 14,
      assists: 3,
      acs: 270,
      firstKills: 4,
      // Détail avancé par map (vue « Avancé »).
      rating: 1.4,
      kast: 78,
      adr: 170,
      hsPercent: 30,
      firstDeaths: 1,
    });
    expect(perMap[1].position).toBe(2);
    expect(perMap[1].map).toBe('Bind');
    expect(perMap[1].agent).toBe('Omen');
  });

  it('map en cours : agents connus, stats nulles ; map pas commencée : ignorée', () => {
    const live = `
<div class="vm-stats-game" data-game-id="all">
  ${ovwTable(statRow('TenZ', 'SEN', null, [1.24, 255, 20, 14, 3, 6, 74, 160, 28, 3, 1, 2]))}
</div>
<div class="vm-stats-game" data-game-id="1">
  ${mapHeader('Ascent', 13, 7)}
  ${ovwTable(statRow('TenZ', 'SEN', 'Jett', [1.4, 270, 20, 14, 3, 11, 78, 170, 30, 3, 1, 2]))}
</div>
<div class="vm-stats-game" data-game-id="2">
  ${mapHeader('Split', 4, 7)}
  ${ovwTable(emptyRow('TenZ', 'SEN', 'Omen'))}
</div>
<div class="vm-stats-game" data-game-id="3">
  ${mapHeader('Breeze', 0, 0)}
  ${ovwTable(emptyRow('TenZ', 'SEN', null))}
</div>`;
    const lines = mapVlrMatchHtml(live, { name: 'Sentinels' }, { name: 'Fnatic' });
    const perMap = lines[0].perMap as MapStatsEntry[];
    expect(perMap).toHaveLength(2);
    expect(perMap[0]).toMatchObject({ map: 'Ascent', agent: 'Jett', kills: 20 });
    // Split en cours : agent pické, stats encore nulles (pas de faux zéros).
    expect(perMap[1]).toMatchObject({ map: 'Split', agent: 'Omen', kills: null, deaths: null });
    // Breeze pas commencée (ni agent ni stats) : absente.
    expect(perMap.find((entry) => entry.map === 'Breeze')).toBeUndefined();
  });

  it('sans en-tête de manche exploitable → side null, extraction intacte', () => {
    const aggregateOnly = `
<div class="vm-stats-game" data-game-id="all">
  ${ovwTable(statRow('TenZ', 'SEN', null, [1, 200, 20, 15, 5, 5, 70, 140, 25, 3, 2, 1]))}
</div>`;
    const lines = mapVlrMatchHtml(aggregateOnly, { name: 'Sentinels' }, { name: 'Fnatic' });
    expect(lines).toHaveLength(1);
    expect(lines[0].side).toBeNull();
    expect(lines[0].perMap).toBeNull();
  });

  it('retourne vide sans bloc de stats « all »', () => {
    expect(mapVlrMatchHtml('<div>rien</div>', { name: 'Sentinels' }, { name: 'Fnatic' })).toHaveLength(0);
  });
});

describe('parseVlrPerformance', () => {
  // Colonnes : [équipe][agent] 2K 3K 4K 5K 1v1 1v2 1v3 1v4 1v5 ECON PL DE.
  // Cellules vides (mod-egg) = 0.
  const row = (name: string, values: string[]) =>
    '<tr>' +
    `<td><div class="team"><img class="team-logo"><div>${name}<div class="team-tag">TLV</div></div></div></td>` +
    '<td><div class="stats-sq"><img></div></td>' +
    values
      .map((value) =>
        value ? `<td><div class="stats-sq">${value}</div></td>` : '<td><div class="stats-sq mod-egg"></div></td>',
      )
      .join('') +
    '</tr>';
  // Classe `mod-adv-stats` (re-design VLR) ; les tables `mod-matrix` (duels)
  // ne doivent pas matcher.
  const html =
    '<table class="wf-table-inset mod-matrix mod-normal"><tbody>' +
    row('daiki', ['8', '8', '8', '8', '8', '8', '8', '8', '8', '88', '8', '8']) +
    '</tbody></table>' +
    '<table class="wf-table-inset mod-adv-stats"><tbody>' +
    '<tr><th></th><th></th><th>2K</th><th>3K</th><th>4K</th><th>5K</th><th>1v1</th><th>1v2</th><th>1v3</th><th>1v4</th><th>1v5</th><th>ECON</th><th>PL</th><th>DE</th></tr>' +
    // daiki : 5×2K, 1×3K, 1×(1v1), ECON 62, 6 plants, 0 defuses.
    row('daiki', ['5', '1', '', '', '1', '', '', '', '', '62', '6', '0']) +
    '</tbody></table>' +
    // Deuxième table mod-adv-stats : détail de la map 1, avec un tooltip
    // « Round N » dont les chiffres ne doivent pas polluer la valeur.
    '<table class="wf-table-inset mod-adv-stats"><tbody>' +
    row('daiki', [
      '3 <div class="wf-popable-contents">Round 5 Xdll Round 13</div>',
      '1',
      '', '', '1', '', '', '', '',
      '70', '4', '0',
    ]) +
    '</tbody></table>';

  it('agrège multikills/clutchs/éco/objectifs de la 1re table (all maps), matrices exclues', () => {
    const perf = parseVlrPerformance(html);
    expect(perf.get('daiki')).toEqual({
      multiKills: 6, // 5 + 1
      clutches: 1, // un 1v1
      econRating: 62,
      plants: 6,
      defuses: 0,
    });
  });

  it('expose aussi les tables par map, tooltips « Round N » ignorés', () => {
    const views = parseVlrPerformanceViews(html);
    expect(views.perGame).toHaveLength(1);
    expect(views.perGame[0].get('daiki')).toMatchObject({
      multiKills: 4, // 3×2K + 1×3K, sans les chiffres du tooltip
      econRating: 70,
      plants: 4,
    });
  });

  it('supporte l’ancienne classe mod-adv (pages archivées)', () => {
    const legacy = html.replace(/mod-adv-stats/g, 'mod-adv');
    expect(parseVlrPerformance(legacy).get('daiki')?.econRating).toBe(62);
  });

  it('renvoie une map vide sans table de performance', () => {
    expect(parseVlrPerformance('<div>rien</div>').size).toBe(0);
  });
});
