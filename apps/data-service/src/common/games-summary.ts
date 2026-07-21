/**
 * Fusion des détails de manches (gamesSummary) provenant de plusieurs
 * sources : Pandascore (winner, durée) et providers de stats (map, scores).
 * Chaque source n'écrase que ses champs non nuls — un sync Pandascore ne
 * doit pas effacer l'enrichissement VLR/bo3, et réciproquement.
 */
export function mergeGamesSummary(
  existing: unknown,
  incoming: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const current = Array.isArray(existing) ? (existing as Array<Record<string, unknown>>) : [];
  const byPosition = new Map(current.map((entry) => [Number(entry.position), { ...entry }]));
  for (const game of incoming) {
    const position = Number(game.position);
    if (!Number.isFinite(position)) continue;
    const entry = byPosition.get(position) ?? { position };
    for (const [key, value] of Object.entries(game)) {
      if (value !== null && value !== undefined) {
        entry[key] = value;
      }
    }
    byPosition.set(position, entry);
  }
  return [...byPosition.values()].sort((a, b) => Number(a.position) - Number(b.position));
}
