import { describe, expect, it } from 'vitest';
import type { Player } from '../../generated/client';
import { mapVlrMatchHtml } from './vlr.provider';

const players = [{ id: 'p1', name: 'TenZ' }] as Player[];

// Structure minimale reproduisant le tableau « both maps » de vlr.gg.
const html = `
<div class="vm-stats-game" data-game-id="all">
  <table class="wf-table-inset">
    <thead>
      <tr>
        <th>Player</th><th></th><th>R2.0</th><th>ACS</th><th>K</th><th>D</th><th>A</th>
        <th>+/–</th><th>KAST</th><th>ADR</th><th>HS%</th><th>FK</th><th>FD</th><th>+/–</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class="mod-player"><div><a><div class="text-of">TenZ</div></a></div></td>
        <td></td>
        <td class="mod-stat"><span class="side mod-both">1.24</span></td>
        <td class="mod-stat"><span class="side mod-both">255</span></td>
        <td class="mod-stat"><span class="side mod-both">42</span></td>
        <td class="mod-stat"><span class="side mod-both">30</span></td>
        <td class="mod-stat"><span class="side mod-both">8</span></td>
        <td class="mod-stat"><span class="side mod-both">+12</span></td>
        <td class="mod-stat"><span class="side mod-both">74%</span></td>
        <td class="mod-stat"><span class="side mod-both">160</span></td>
        <td class="mod-stat"><span class="side mod-both">28%</span></td>
        <td class="mod-stat"><span class="side mod-both">6</span></td>
        <td class="mod-stat"><span class="side mod-both">3</span></td>
        <td class="mod-stat"><span class="side mod-both">+3</span></td>
      </tr>
      <tr>
        <td class="mod-player"><div><a><div class="text-of">Inconnu</div></a></div></td>
        <td></td>
        <td class="mod-stat"><span class="side mod-both">0.9</span></td>
        <td class="mod-stat"><span class="side mod-both">180</span></td>
        <td class="mod-stat"><span class="side mod-both">25</span></td>
        <td class="mod-stat"><span class="side mod-both">32</span></td>
        <td class="mod-stat"><span class="side mod-both">10</span></td>
        <td class="mod-stat"><span class="side mod-both">-7</span></td>
        <td class="mod-stat"><span class="side mod-both">60%</span></td>
        <td class="mod-stat"><span class="side mod-both">120</span></td>
        <td class="mod-stat"><span class="side mod-both">20%</span></td>
        <td class="mod-stat"><span class="side mod-both">2</span></td>
        <td class="mod-stat"><span class="side mod-both">5</span></td>
        <td class="mod-stat"><span class="side mod-both">-3</span></td>
      </tr>
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

  it('retourne vide sans bloc de stats « all »', () => {
    expect(mapVlrMatchHtml('<div>rien</div>', players)).toHaveLength(0);
  });
});
