import type { MatchDaySummary } from '@/lib/types';

/**
 * Helpers purs de la timeline des journées (testés à part, et hors de
 * `page.tsx` : Next n'admet que ses propres exports dans un fichier de page).
 */

/** Date calendaire Europe/Paris du jour (YYYY-MM-DD). */
export function todayParis(): string {
  return new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
}

/**
 * Journée ouverte à l'arrivée sur la ligue : celle du JOUR d'abord — c'est
 * elle qu'on vient regarder, et sa deadline est déjà passée dès le premier
 * match, ce qui la faisait auparavant sauter au lendemain. À défaut, la
 * prochaine journée encore ouverte, sinon la dernière jouée.
 */
export function journeeParDefaut(days: MatchDaySummary[]): MatchDaySummary | null {
  const today = todayParis();
  return (
    days.find((day) => day.date === today) ??
    days.find((day) => !day.deadlinePassed) ??
    days.at(-1) ??
    null
  );
}

/**
 * Décalage à appliquer au scroll d'une timeline pour CENTRER une pilule, 0 si
 * elle est déjà entièrement visible (on ne bouge pas la vue sous les doigts de
 * quelqu'un qui vient de faire défiler). Raisonne en rectangles écran : le
 * conteneur n'est pas l'`offsetParent` des pilules.
 */
export function decalageCentrage(
  timeline: { left: number; width: number },
  chip: { left: number; width: number },
): number {
  const visible =
    chip.left >= timeline.left && chip.left + chip.width <= timeline.left + timeline.width;
  if (visible) return 0;
  return Math.round(chip.left - timeline.left - (timeline.width - chip.width) / 2);
}
