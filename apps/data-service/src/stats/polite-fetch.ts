/** Fetch poli pour les API publiques/scraping : espacement par hôte + User-Agent. */

const USER_AGENT = 'ESFL/0.1 (fantasy league open-source; usage personnel non commercial)';
/**
 * Prochain créneau disponible par hôte. La réservation est synchrone (pas
 * d'await entre lecture et écriture) : des appels concurrents d'un même hôte
 * se sérialisent proprement — chacun prend le créneau suivant — tandis que
 * les hôtes différents attendent en parallèle. C'est ce qui permet au worker
 * d'ingestion de traiter plusieurs jobs de front sans jamais dépasser le
 * rythme d'aucune source.
 */
const nextSlotByHost = new Map<string, number>();

export async function politeFetch(
  url: string | URL,
  init: RequestInit = {},
  minSpacingMs = 1_000,
): Promise<Response> {
  const host = new URL(url).host;
  const now = Date.now();
  const slot = Math.max(now, nextSlotByHost.get(host) ?? 0);
  nextSlotByHost.set(host, slot + minSpacingMs);
  const wait = slot - now;
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return fetch(url, {
    ...init,
    headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) },
  });
}
