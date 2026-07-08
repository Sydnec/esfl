/** Fetch poli pour les API publiques/scraping : espacement par hôte + User-Agent. */

const USER_AGENT = 'ESFL/0.1 (fantasy league open-source; usage personnel non commercial)';
const lastCallByHost = new Map<string, number>();

export async function politeFetch(
  url: string | URL,
  init: RequestInit = {},
  minSpacingMs = 1_000,
): Promise<Response> {
  const host = new URL(url).host;
  const wait = (lastCallByHost.get(host) ?? 0) + minSpacingMs - Date.now();
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastCallByHost.set(host, Date.now());
  return fetch(url, {
    ...init,
    headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) },
  });
}
