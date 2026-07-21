/**
 * Rapprochement d'entités entre sources externes (ballchasing, Leaguepedia,
 * VLR, bo3) et notre référentiel Pandascore. Pur pour être testable.
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

/** Équipe locale vue des providers : nom Pandascore + alias appris. */
export interface TeamRef {
  name: string;
  aliases?: string[];
}

/**
 * Un nom externe correspond à une équipe locale par son nom (rapprochement
 * flou, le nom Pandascore est fiable) ou par égalité exacte à l'un de ses
 * alias. Les alias sont matchés en exact — pas en sous-chaîne : un alias court
 * appris automatiquement (« LP ») ne doit jamais absorber une équipe tierce
 * dont le nom le contient (« LPL », « Liquid Pro »).
 */
export function teamMatches(externalName: string, team: TeamRef): boolean {
  if (teamNamesMatch(externalName, team.name)) return true;
  const normalized = normalizeName(externalName);
  return (team.aliases ?? []).some((alias) => normalizeName(alias) === normalized);
}

/**
 * Variante STRICTE : égalité normalisée exacte au nom ou à un alias, sans la
 * sous-chaîne floue de `teamNamesMatch`. Indispensable quand une même fenêtre
 * contient une équipe et ses dérivées : « Cloud9 » ne doit PAS matcher
 * « Cloud9 Academy » ni « Sentinels » matcher « Sentinels GC », sinon les
 * rosters de deux parties distinctes fusionnent. À utiliser là où le nom
 * externe est fiable et canonique (Leaguepedia : `SG.Team1/Team2`).
 */
export function teamMatchesExact(externalName: string, team: TeamRef): boolean {
  const normalized = normalizeName(externalName);
  if (!normalized) return false;
  if (normalized === normalizeName(team.name)) return true;
  return (team.aliases ?? []).some((alias) => normalizeName(alias) === normalized);
}

/** Affiche d'une rencontre côté provider, pour la corrélation adverse. */
export interface OpponentPair {
  nameA: string;
  nameB: string;
  /** Écart avec le coup d'envoi local (ms), si la source date la rencontre. */
  deltaMs?: number | null;
}

/**
 * Corrélation par l'adversaire : parmi les affiches d'un provider, si une
 * seule équipe est reconnue et que l'autre nom ne correspond à rien, ce nom
 * est un alias probable de l'équipe locale adverse. On n'apprend que si un
 * unique candidat se dégage (une équipe peut jouer plusieurs fois dans la
 * fenêtre : deux candidats distincts = ambigu, on s'abstient).
 */
export function inferOpponentAlias(
  pairs: OpponentPair[],
  teamA: TeamRef,
  teamB: TeamRef,
  maxDeltaMs?: number,
): { team: 'A' | 'B'; alias: string } | null {
  const candidates = opponentAliasCandidates(pairs, teamA, teamB, maxDeltaMs);
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Tous les alias candidats (dédupliqués) : pour chaque affiche où une seule
 * équipe locale est reconnue, le nom d'en face est un alias possible de
 * l'adverse. Sert au matching manuel assisté (pré-remplissage admin) ; l'auto
 * n'apprend que si un unique candidat se dégage.
 */
export function opponentAliasCandidates(
  pairs: OpponentPair[],
  teamA: TeamRef,
  teamB: TeamRef,
  maxDeltaMs?: number,
): Array<{ team: 'A' | 'B'; alias: string }> {
  const candidates = new Map<string, { team: 'A' | 'B'; alias: string }>();
  for (const pair of pairs) {
    // Un nom trop court (« 2 », tag d'un caster) n'est jamais un alias
    // crédible : ni appris, ni même proposé.
    if (normalizeName(pair.nameA).length < 3 || normalizeName(pair.nameB).length < 3) continue;
    if (
      maxDeltaMs !== undefined &&
      pair.deltaMs !== undefined &&
      pair.deltaMs !== null &&
      Math.abs(pair.deltaMs) > maxDeltaMs
    ) {
      continue;
    }
    const flags = [
      { name: pair.nameA, other: pair.nameB },
      { name: pair.nameB, other: pair.nameA },
    ].map(({ name, other }) => ({
      matchesA: teamMatches(name, teamA),
      matchesB: teamMatches(name, teamB),
      otherMatchesAny: teamMatches(other, teamA) || teamMatches(other, teamB),
      other,
    }));
    for (const flag of flags) {
      if (flag.otherMatchesAny || !flag.other) continue;
      if (flag.matchesA && !flag.matchesB) {
        candidates.set(`B:${normalizeName(flag.other)}`, { team: 'B', alias: flag.other });
      } else if (flag.matchesB && !flag.matchesA) {
        candidates.set(`A:${normalizeName(flag.other)}`, { team: 'A', alias: flag.other });
      }
    }
  }
  return [...candidates.values()];
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
