import type { GameId } from '@esfl/contracts';

/** Colonnes de stats par jeu (clé du normalized + libellé court). */
export const STAT_COLUMNS: Record<GameId, Array<{ key: string; label: string }>> = {
  cs2: [
    { key: 'kills', label: 'K' },
    { key: 'deaths', label: 'D' },
    { key: 'assists', label: 'A' },
    { key: 'adr', label: 'ADR' },
  ],
  valorant: [
    { key: 'kills', label: 'K' },
    { key: 'deaths', label: 'D' },
    { key: 'assists', label: 'A' },
    { key: 'acs', label: 'ACS' },
    { key: 'firstKills', label: 'FK' },
  ],
  lol: [
    { key: 'kills', label: 'K' },
    { key: 'deaths', label: 'D' },
    { key: 'assists', label: 'A' },
    { key: 'csPerMin', label: 'CS/min' },
    { key: 'win', label: 'Résultat' },
  ],
  rl: [
    { key: 'goals', label: 'Buts' },
    { key: 'assists', label: 'Passes' },
    { key: 'saves', label: 'Arrêts' },
    { key: 'shots', label: 'Tirs' },
    { key: 'score', label: 'Score' },
  ],
};

export function formatStat(value: number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '·';
  if (typeof value === 'boolean') return value ? 'V' : 'D';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
