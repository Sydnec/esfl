/**
 * TEMPORAIRE — ce fichier, son test et la section « Dégel de rattrapage » de la
 * page admin sont à supprimer à la mise en prod suivante.
 *
 * L'échéance du gel des journées est passée de 3 à 7 jours. Les journées gelées
 * sous l'ancienne règle le restent : leurs matchs dont les stats sont arrivées
 * entre J+3 et J+7 n'ont jamais reçu de note, et le gel interdit de la calculer.
 * Le bouton rouvre cette fenêtre, après quoi le rattrapage des notes comble les
 * trous ; le gel automatique refermera ces journées de lui-même, après un
 * dernier re-score.
 */
const DEGEL_RATTRAPAGE_JOURS = [4, 5, 6, 7];

/**
 * Dates Paris (YYYY-MM-DD) de la fenêtre de rattrapage, de la plus récente à la
 * plus ancienne.
 */
export function datesDeRattrapage(maintenant = Date.now()): string[] {
  return DEGEL_RATTRAPAGE_JOURS.map((jours) =>
    new Date(maintenant - jours * 24 * 3600 * 1000).toLocaleDateString('fr-CA', {
      timeZone: 'Europe/Paris',
    }),
  );
}
