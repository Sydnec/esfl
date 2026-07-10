/**
 * Rapprochement d'entités entre sources externes (Octane, Leaguepedia, VLR,
 * Grid) et notre référentiel Pandascore. Pur pour être testable.
 */

/** Minuscules, sans diacritiques, sans ponctuation/espaces. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Deux noms d'équipe correspondent si l'un contient l'autre une fois normalisés. */
export function teamNamesMatch(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

export interface NamedPlayer {
  id: string;
  name: string;
}

/** Index nom normalisé → joueur local. */
export function buildPlayerIndex(players: NamedPlayer[]): Map<string, NamedPlayer> {
  return new Map(players.map((player) => [normalizeName(player.name), player]));
}

/**
 * Retrouve un joueur local par son pseudo externe : correspondance exacte
 * normalisée, sinon repli par inclusion stricte quand elle est unique et
 * assez longue (« Djon » chez Grid vs « Djon8 » chez Pandascore).
 */
export function matchPlayer(
  index: Map<string, NamedPlayer>,
  externalName: string,
): NamedPlayer | null {
  const key = normalizeName(externalName);
  const exact = index.get(key);
  if (exact) return exact;
  if (key.length < 3) return null;

  const candidates = [...index.entries()].filter(
    ([name]) => name.length >= 3 && (name.includes(key) || key.includes(name)),
  );
  return candidates.length === 1 ? candidates[0][1] : null;
}
