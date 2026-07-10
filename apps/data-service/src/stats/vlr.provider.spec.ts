import { describe, expect, it } from 'vitest';
import type { MapStatsEntry } from '@esfl/contracts';
import type { Player } from '../../generated/client';
import { mapVlrMatchHtml } from './vlr.provider';

const players = [{ id: 'p1', name: 'TenZ' }] as Player[];

function statRow(name: string, agent: string | null, values: number[]): string {
  const agentCell = agent
    ? `<td class="mod-agent"><img title="${agent}" alt="${agent}"></td>`
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

// Structure minimale reproduisant une page match vlr.gg : tableau agrégé
// « all » + un bloc par manche avec en-tête (map, scores) et colonne agent.
// Ordre des valeurs : R2.0, ACS, K, D, A, +/-, KAST, ADR, HS%, FK, FD, +/-.
const html = `
<div class="vm-stats-game" data-game-id="all">
  <table class="wf-table-inset">
    ${tableHead}
    <tbody>
      ${statRow('TenZ', null, [1.24, 255, 42, 30, 8, 12, 74, 160, 28, 6, 3, 3])}
      ${statRow('Inconnu', null, [0.9, 180, 25, 32, 10, -7, 60, 120, 20, 2, 5, -3])}
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
  it('repère les colonnes par en-tête et mappe les joueurs connus', () => {
    const lines = mapVlrMatchHtml(html, players);
    expect(lines).toHaveLength(1);
    expect(lines[0].playerId).toBe('p1');
    expect(lines[0].normalized).toEqual({
      kills: 42,
      deaths: 30,
      assists: 8,
      acs: 255,
      firstKills: 6,
    });
  });

  it('extrait le détail par manche avec agent et nom de map', () => {
    const lines = mapVlrMatchHtml(html, players);
    const perMap = lines[0].perMap as MapStatsEntry[];
    expect(perMap).toHaveLength(2);
    expect(perMap[0]).toEqual({
      position: 1,
      map: 'Ascent',
      agent: 'Jett',
      kills: 25,
      deaths: 14,
      assists: 3,
      acs: 270,
      firstKills: 4,
    });
    expect(perMap[1].position).toBe(2);
    expect(perMap[1].map).toBe('Bind');
    expect(perMap[1].agent).toBe('Omen');
    expect(perMap[1].kills).toBe(17);
  });

  it('agent absent → null, sans bloc par manche → perMap null', () => {
    const aggregateOnly = `
<div class="vm-stats-game" data-game-id="all">
  <table>${tableHead}<tbody>${statRow('TenZ', null, [1, 200, 20, 15, 5, 5, 70, 140, 25, 3, 2, 1])}</tbody></table>
</div>`;
    const lines = mapVlrMatchHtml(aggregateOnly, players);
    expect(lines).toHaveLength(1);
    expect(lines[0].perMap).toBeNull();
  });

  it('retourne vide sans bloc de stats « all »', () => {
    expect(mapVlrMatchHtml('<div>rien</div>', players)).toHaveLength(0);
  });
});
