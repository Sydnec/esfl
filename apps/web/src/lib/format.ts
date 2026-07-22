/** Heure compacte : « 14:00 » si c'est aujourd'hui, sinon « mer. 14:00 ». */
export function formatKickoff(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const now = new Date();
  const time = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) {
    return time;
  }
  // Au-delà de 7 jours, la date complète est plus parlante que le jour de semaine.
  if (date.getTime() - now.getTime() > 7 * 24 * 3600 * 1000) {
    const day = date.toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
    });
    return `${day} ${time}`;
  }
  return `${date.toLocaleDateString('fr-FR', { weekday: 'short' })} ${time}`;
}

/** Date et heure complètes : « 8 juil. 18:00 ». */
export function formatDateTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const day = date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  const time = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return `${day} ${time}`;
}

/** Date calendaire Europe/Paris (YYYY-MM-DD) d'un instant ISO. */
export function parisDateOf(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
}

/** Date courte pour la timeline : « mer. 15/07 ». */
export function formatDayChip(dateIso: string): string {
  const date = new Date(`${dateIso}T12:00:00`);
  return `${date.toLocaleDateString('fr-FR', { weekday: 'short' })} ${date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })}`;
}

/**
 * Les points fantasy d'un match en cours sont provisoires : la note porte sur
 * une partie incomplète et bouge à chaque round. On ne les affiche qu'une fois
 * le match terminé.
 */
export function pointsDefinitifs(status: string): boolean {
  return status === 'finished';
}
