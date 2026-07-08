/**
 * Logique de verrouillage des joueurs, pure pour être testable.
 *
 * Règle : un joueur aligné par un utilisateur lors de la journée `sourceDate`
 * reste verrouillé pour cet utilisateur tant que moins de `lockMatchDays`
 * journées de la ligue se sont écoulées strictement entre la journée source
 * et la journée cible.
 *
 * Exemple avec lockMatchDays = 1 : pické le jour J1, verrouillé pour J2
 * (0 journée entre J1 et J2), disponible à nouveau dès J3.
 */
export function isLockedForDay(params: {
  /** Dates (YYYY-MM-DD) de toutes les journées de la ligue, ordre libre. */
  leagueDayDates: string[];
  /** Journée où le joueur a été aligné. */
  sourceDate: string;
  /** Journée pour laquelle on veut aligner le joueur. */
  targetDate: string;
  lockMatchDays: number;
}): boolean {
  const { leagueDayDates, sourceDate, targetDate, lockMatchDays } = params;
  if (targetDate <= sourceDate) {
    return false;
  }
  const daysBetween = leagueDayDates.filter(
    (date) => date > sourceDate && date < targetDate,
  ).length;
  return daysBetween < lockMatchDays;
}

/**
 * Première journée (strictement postérieure à la source) où le joueur
 * redevient disponible, ou null si elle n'est pas encore connue.
 */
export function unlockDate(params: {
  leagueDayDates: string[];
  sourceDate: string;
  lockMatchDays: number;
}): string | null {
  const { leagueDayDates, sourceDate, lockMatchDays } = params;
  const following = [...new Set(leagueDayDates)].filter((date) => date > sourceDate).sort();
  return following[lockMatchDays] ?? null;
}
