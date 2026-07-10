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

/** Substitutions leetspeak courantes, pliées des deux côtés de la comparaison. */
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't' };

function leetFold(normalized: string): string {
  return normalized.replace(/[013457]/g, (char) => LEET[char] ?? char);
}

/**
 * Retrouve un joueur local par son pseudo externe. Dans l'ordre :
 * correspondance exacte normalisée ; égalité après pliage leetspeak
 * (« sh1n » VLR vs « Shin » Pandascore) ; inclusion stricte, chaque repli
 * uniquement s'il est non ambigu et assez long (« Djon » Grid vs « Djon8 »).
 */
export function matchPlayer(
  index: Map<string, NamedPlayer>,
  externalName: string,
): NamedPlayer | null {
  const key = normalizeName(externalName);
  const exact = index.get(key);
  if (exact) return exact;
  if (key.length < 3) return null;

  const folded = leetFold(key);
  const foldMatches = [...index.entries()].filter(([name]) => leetFold(name) === folded);
  if (foldMatches.length === 1) return foldMatches[0][1];

  const candidates = [...index.entries()].filter(
    ([name]) => name.length >= 3 && (name.includes(key) || key.includes(name)),
  );
  return candidates.length === 1 ? candidates[0][1] : null;
}
