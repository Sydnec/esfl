const formatter = new Intl.DateTimeFormat('fr-CA', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Date calendaire Europe/Paris (YYYY-MM-DD) d'un instant donné. */
export function parisDate(instant: Date): string {
  return formatter.format(instant);
}
