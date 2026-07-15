import { describe, expect, it } from 'vitest';
import type { MapStatsEntry } from '@esfl/contracts';
import { mapVlrMatchHtml, parseVlrRoster, parseVlrTeamSearch } from './vlr.provider';

/** Item de roster VLR : `role` vide = titulaire ; sinon remplaçant/staff. */
const rosterItem = (alias: string, role = '') =>
  `<div class="team-roster-item"><a href="/player/1/${alias}" style="display:flex;">` +
  `<div class="team-roster-item-name"><div class="team-roster-item-name-alias">` +
  `<i class="flag mod-gb"></i>${alias}</div>` +
  (role ? `<div class="team-roster-item-name-role">${role}</div>` : '') +
  `</div></a></div>`;

describe('parseVlrRoster', () => {
  it('ne garde que les joueurs sans rôle (exclut sub et staff)', () => {
    const html =
      rosterItem('musashi') +
      rosterItem('azury') +
      rosterItem('Fizzy') +
      rosterItem('MONSTEERR') +
      rosterItem('Jamelinho') +
      rosterItem('kendo', 'sub') +
      rosterItem('Sebe', 'head coach');
    expect(parseVlrRoster(html).map((s) => s.name)).toEqual([
      'musashi',
      'azury',
      'Fizzy',
      'MONSTEERR',
      'Jamelinho',
    ]);
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
