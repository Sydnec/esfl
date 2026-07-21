import type { GameId } from '@esfl/contracts';

export interface StatColumn {
  key: string;
  label: string;
  /** Nom complet, affiché au survol de l'en-tête. */
  title: string;
  /** Ratio 0-1 à afficher en pourcentage (« 58 % »). */
  pct?: boolean;
}

export interface StatColumnGroup {
  /** Colonnes essentielles (vue par défaut). */
  base: StatColumn[];
  /** Colonnes avancées (second onglet, comme sur VLR). */
  advanced: StatColumn[];
}

/**
 * Colonnes de stats par jeu (clé du normalized + libellé court), en deux
 * groupes pour tenir en largeur sans ascenseur : essentiel et avancé.
 * Les stats que la source ne fournit pas rendent « · ».
 */
export const STAT_COLUMNS: Record<GameId, StatColumnGroup> = {
  cs2: {
    base: [
      { key: 'kills', label: 'K', title: 'Kills' },
      { key: 'deaths', label: 'D', title: 'Morts' },
      { key: 'assists', label: 'A', title: 'Assists' },
      { key: 'adr', label: 'ADR', title: 'Dégâts moyens par round' },
    ],
    // bo3 ne publie ni bombes posées ni défusées : colonnes retirées, elles ne
    // rendaient que des « · ».
    advanced: [
      { key: 'kast', label: 'KAST', title: 'Kill, assist, trade ou survie (% de rounds)' },
      { key: 'firstKills', label: 'FK', title: 'First kills (rounds ouverts)' },
      { key: 'firstDeaths', label: 'FD', title: 'First deaths (entrées perdues)' },
      { key: 'multiKills', label: 'MK', title: 'Manches à 2 kills ou plus' },
      { key: 'clutches', label: 'CL', title: 'Clutchs gagnés (1v1 à 1v5)' },
      { key: 'headshots', label: 'HS', title: 'Kills à la tête' },
    ],
  },
  valorant: {
    base: [
      { key: 'kills', label: 'K', title: 'Kills' },
      { key: 'deaths', label: 'D', title: 'Morts' },
      { key: 'assists', label: 'A', title: 'Assists' },
      { key: 'acs', label: 'ACS', title: 'Average combat score' },
      { key: 'firstKills', label: 'FK', title: 'First kills (entrées gagnées)' },
    ],
    // Rating, multikills et clutchs sont parsés (scoring) mais pas affichés.
    advanced: [
      { key: 'adr', label: 'ADR', title: 'Dégâts moyens par round' },
      { key: 'kast', label: 'KAST', title: 'Kill, assist, trade ou survie (% de rounds)' },
      { key: 'hsPercent', label: 'HS %', title: 'Pourcentage de headshots' },
      { key: 'firstDeaths', label: 'FD', title: 'First deaths (entrées perdues)' },
      { key: 'plants', label: 'PL', title: 'Spikes posées' },
      { key: 'defuses', label: 'DE', title: 'Spikes défusées' },
      { key: 'econRating', label: 'ECON', title: 'Note d’économie VLR' },
    ],
  },
  lol: {
    base: [
      { key: 'kills', label: 'K', title: 'Kills' },
      { key: 'deaths', label: 'D', title: 'Morts' },
      { key: 'assists', label: 'A', title: 'Assists' },
      { key: 'csPerMin', label: 'CS/min', title: 'Creeps tués par minute' },
    ],
    advanced: [
      { key: 'killParticipation', label: 'KP', title: 'Participation aux kills de l’équipe', pct: true },
      { key: 'damageShare', label: 'DMG', title: 'Part des dégâts aux champions de l’équipe', pct: true },
      { key: 'goldShare', label: 'Or', title: 'Part de l’or de l’équipe', pct: true },
      { key: 'visionScore', label: 'Vision', title: 'Score de vision' },
    ],
  },
};

/** Clés disponibles dans le détail par manche (perMap) : les autres colonnes
 * n'existent qu'en cumulé et rendraient « · » sur une vue par map. */
export const PER_MAP_KEYS = new Set([
  'kills',
  'deaths',
  'assists',
  'acs',
  'firstKills',
  'csPerMin',
  // Avancé par map (VLR, onglet Performance inclus).
  'adr',
  'rating',
  'kast',
  'hsPercent',
  'headshots',
  'firstDeaths',
  'multiKills',
  'clutches',
  'plants',
  'defuses',
  'econRating',
  // Avancé par game (Leaguepedia).
  'killParticipation',
  'damageShare',
  'goldShare',
  'visionScore',
]);

export function formatStat(
  value: number | boolean | null | undefined,
  pct = false,
): string {
  if (value === null || value === undefined) return '·';
  if (typeof value === 'boolean') return value ? 'V' : 'D';
  if (pct) return `${Math.round(value * 100)} %`;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
