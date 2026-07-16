/**
 * Précédence des sources par champ : les providers de stats (VLR, Leaguepedia,
 * Grid…) sont source de vérité, Pandascore n'est qu'un fallback. Chaque entité
 * (Team, Player) porte un Json `fieldSources` — `{ name: "vlr", role:
 * "leaguepedia" }` — listant les champs possédés par un provider. Null = tout
 * appartient encore à Pandascore.
 */

/** Champ → source provider qui le possède. */
export type FieldSources = Record<string, string>;

/** Lecture sûre du Json Prisma (null/objet quelconque) vers FieldSources. */
export function asFieldSources(value: unknown): FieldSources {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const sources: FieldSources = {};
  for (const [key, source] of Object.entries(value as Record<string, unknown>)) {
    if (typeof source === 'string') sources[key] = source;
  }
  return sources;
}

/**
 * Mise à jour venant de Pandascore : les champs possédés par un provider sont
 * retirés (jamais ré-écrasés), les autres passent tels quels (y compris null —
 * Pandascore reste maître des champs qu'aucun provider n'a revendiqués).
 */
export function pandascoreUpdate<T extends Record<string, unknown>>(
  data: T,
  fieldSources: unknown,
): Partial<T> {
  const owned = asFieldSources(fieldSources);
  const update: Partial<T> = {};
  for (const [key, value] of Object.entries(data)) {
    if (owned[key]) continue;
    (update as Record<string, unknown>)[key] = value;
  }
  return update;
}

/**
 * Mise à jour venant d'un provider : seules les valeurs renseignées sont
 * écrites (un provider muet sur un champ laisse le fallback Pandascore en
 * place), chacune est marquée possédée par `source` dans `fieldSources`.
 */
export function providerUpdate<T extends Record<string, unknown>>(
  data: T,
  source: string,
  fieldSources: unknown,
): { data: { [K in keyof T]?: NonNullable<T[K]> }; fieldSources: FieldSources } {
  const merged = asFieldSources(fieldSources);
  const update: { [K in keyof T]?: NonNullable<T[K]> } = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    (update as Record<string, unknown>)[key] = value;
    merged[key] = source;
  }
  return { data: update, fieldSources: merged };
}
