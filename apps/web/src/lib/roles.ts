/** Ordre usuel des rôles LoL : TOP → JUN → MID → ADC → SUP. */
const LOL_ROLE_RANK: Array<[RegExp, number]> = [
  [/top/i, 0],
  [/jun|jgl|jng/i, 1],
  [/mid|middle/i, 2],
  [/bot|adc|carry/i, 3],
  [/sup/i, 4],
];

/** Rang d'un rôle LoL (99 si inconnu, placé en fin). */
export function lolRoleRank(role: string | null | undefined): number {
  if (!role) return 99;
  for (const [re, rank] of LOL_ROLE_RANK) {
    if (re.test(role)) return rank;
  }
  return 99;
}

/**
 * Trie les joueurs d'une équipe : pour LoL, dans l'ordre usuel des rôles
 * (TOP/JUN/MID/ADC/SUP) ; sinon par nom. Suppose une équipe homogène en jeu.
 */
export function sortTeamPlayers<T extends { role: string | null; name: string; gameId: string }>(
  players: T[],
): T[] {
  return [...players].sort((a, b) => {
    if (a.gameId === 'lol') {
      const byRole = lolRoleRank(a.role) - lolRoleRank(b.role);
      if (byRole !== 0) return byRole;
    }
    return a.name.localeCompare(b.name);
  });
}
