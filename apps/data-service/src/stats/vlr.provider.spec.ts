import { describe, expect, it } from 'vitest';
import type { MapStatsEntry } from '@esfl/contracts';
import { mapVlrMatchHtml } from './vlr.provider';

function statRow(name: string, agent: string | null, values: number[]): string {
  const agentCell = agent
    ? `<td class="mod-agent"><img title="${agent}" alt="${agent}" src="/img/vlr/game/agents/${agent.toLowerCase()}.png"></td>`
    : '<td></td>';
  return `
      <tr>
        <td class="mod-player"><div><a><div class="text-of">${name}</div></a></div></td>
        ${agentCell}
        ${values.map((value) => `<td class="mod-stat"><span class="side mod-both">${value}</span></td>`).join('\n')}
      </tr>`;
}

const tableHead = `
    <thead>
      <tr>
        <th>Player</th><th></th><th>R2.0</th><th>ACS</th><th>K</th><th>D</th><th>A</th>
        <th>+/–</th><th>KAST</th><th>ADR</th><th>HS%</th><th>FK</th><th>FD</th><th>+/–</th>
      </tr>
    </thead>`;

// Structure minimale reproduisant une page match vlr.gg : bloc agrégé
// « all » avec un tableau PAR ÉQUIPE (gauche = Sentinels, droite = Fnatic),
// + un bloc par manche avec en-tête (map, scores) et colonne agent.
// Ordre des valeurs : R2.0, ACS, K, D, A, +/-, KAST, ADR, HS%, FK, FD, +/-.
const html = `
<div class="vm-stats-game" data-game-id="all">
  <table class="wf-table-inset">
    ${tableHead}
    <tbody>
      ${statRow('TenZ', null, [1.24, 255, 42, 30, 8, 12, 74, 160, 28, 6, 3, 3])}
      ${statRow('NouveauSentinel', null, [0.9, 180, 25, 32, 10, -7, 60, 120, 20, 2, 5, -3])}
    </tbody>
  </table>
  <table class="wf-table-inset">
    ${tableHead}
    <tbody>
      ${statRow('Boaster', null, [1.02, 200, 30, 31, 12, -1, 68, 130, 22, 3, 4, -1])}
    </tbody>
  </table>
</div>
<div class="vm-stats-game" data-game-id="171001">
  <div class="vm-stats-game-header">
    <div class="team"><div class="score">13</div><div class="team-name">Sentinels</div></div>
    <div class="map"><span>Ascent
PICK</span></div>
    <div class="team mod-right"><div class="score">7</div><div class="team-name">Fnatic</div></div>
  </div>
  <table class="wf-table-inset">
    ${tableHead}
    <tbody>
      ${statRow('TenZ', 'Jett', [1.4, 270, 25, 14, 3, 11, 78, 170, 30, 4, 1, 3])}
    </tbody>
  </table>
</div>
<div class="vm-stats-game" data-game-id="171002">
  <div class="vm-stats-game-header">
    <div class="team"><div class="score">10</div><div class="team-name">Sentinels</div></div>
    <div class="map"><span>Bind</span></div>
    <div class="team mod-right"><div class="score">13</div><div class="team-name">Fnatic</div></div>
  </div>
  <table class="wf-table-inset">
    ${tableHead}
    <tbody>
      ${statRow('TenZ', 'Omen', [1.1, 240, 17, 16, 5, 1, 70, 150, 26, 2, 2, 0])}
    </tbody>
  </table>
</div>`;

describe('mapVlrMatchHtml', () => {
  it('extrait toutes les lignes avec pseudo et côté A/B résolu par tableau', () => {
    const lines = mapVlrMatchHtml(html, 'Sentinels', 'Fnatic');
    expect(lines).toHaveLength(3);
    const tenz = lines.find((line) => line.externalName === 'TenZ');
    expect(tenz?.side).toBe('A');
    expect(tenz?.normalized).toEqual({
      kills: 42,
      deaths: 30,
      assists: 8,
      acs: 255,
      firstKills: 6,
    });
    // Joueur inconnu du référentiel : quand même extrait, avec son côté.
    expect(lines.find((line) => line.externalName === 'NouveauSentinel')?.side).toBe('A');
    expect(lines.find((line) => line.externalName === 'Boaster')?.side).toBe('B');
  });

  it('résout le côté avec les équipes inversées (droite = A)', () => {
    const lines = mapVlrMatchHtml(html, 'Fnatic', 'Sentinels');
    expect(lines.find((line) => line.externalName === 'TenZ')?.side).toBe('B');
    expect(lines.find((line) => line.externalName === 'Boaster')?.side).toBe('A');
  });

  it('extrait le détail par manche avec agent et nom de map', () => {
    const lines = mapVlrMatchHtml(html, 'Sentinels', 'Fnatic');
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
    const emptyRow = (name: string, agent: string | null) => {
      const agentCell = agent
        ? `<td class="mod-agent"><img title="${agent}" alt="${agent}" src="/img/vlr/game/agents/${agent.toLowerCase()}.png"></td>`
        : '<td></td>';
      const cells = Array.from(
        { length: 12 },
        () => '<td class="mod-stat"><span class="side mod-both">&nbsp;</span></td>',
      ).join('\n');
      return `<tr><td class="mod-player"><div><a><div class="text-of">${name}</div></a></div></td>${agentCell}${cells}</tr>`;
    };
    const live = `
<div class="vm-stats-game" data-game-id="all">
  <table>${tableHead}<tbody>${statRow('TenZ', null, [1.24, 255, 20, 14, 3, 6, 74, 160, 28, 3, 1, 2])}</tbody></table>
</div>
<div class="vm-stats-game" data-game-id="1">
  <div class="vm-stats-game-header">
    <div class="team"><div class="score">13</div><div class="team-name">Sentinels</div></div>
    <div class="map"><span>Ascent</span></div>
    <div class="team mod-right"><div class="score">7</div><div class="team-name">Fnatic</div></div>
  </div>
  <table>${tableHead}<tbody>${statRow('TenZ', 'Jett', [1.4, 270, 20, 14, 3, 11, 78, 170, 30, 3, 1, 2])}</tbody></table>
</div>
<div class="vm-stats-game" data-game-id="2">
  <div class="vm-stats-game-header">
    <div class="team"><div class="score">4</div><div class="team-name">Sentinels</div></div>
    <div class="map"><span>Split</span></div>
    <div class="team mod-right"><div class="score">7</div><div class="team-name">Fnatic</div></div>
  </div>
  <table>${tableHead}<tbody>${emptyRow('TenZ', 'Omen')}</tbody></table>
</div>
<div class="vm-stats-game" data-game-id="3">
  <div class="vm-stats-game-header">
    <div class="team"><div class="score">0</div><div class="team-name">Sentinels</div></div>
    <div class="map"><span>Breeze</span></div>
    <div class="team mod-right"><div class="score">0</div><div class="team-name">Fnatic</div></div>
  </div>
  <table>${tableHead}<tbody>${emptyRow('TenZ', null)}</tbody></table>
</div>`;
    const lines = mapVlrMatchHtml(live, 'Sentinels', 'Fnatic');
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
  <table>${tableHead}<tbody>${statRow('TenZ', null, [1, 200, 20, 15, 5, 5, 70, 140, 25, 3, 2, 1])}</tbody></table>
</div>`;
    const lines = mapVlrMatchHtml(aggregateOnly, 'Sentinels', 'Fnatic');
    expect(lines).toHaveLength(1);
    expect(lines[0].side).toBeNull();
    expect(lines[0].perMap).toBeNull();
  });

  it('retourne vide sans bloc de stats « all »', () => {
    expect(mapVlrMatchHtml('<div>rien</div>', 'Sentinels', 'Fnatic')).toHaveLength(0);
  });
});
