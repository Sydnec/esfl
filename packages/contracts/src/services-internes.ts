/** Variables portant l'URL d'un service appelé en interne. */
export type NomUrlService =
  'AUTH_SERVICE_URL' | 'DATA_SERVICE_URL' | 'FANTASY_SERVICE_URL' | 'SCORING_SERVICE_URL';

/**
 * Refuse le démarrage quand une URL de service appelé manque EN PRODUCTION.
 *
 * Chaque client se replie sur `http://localhost:<port>` quand la variable est
 * absente : c'est juste en développement, où les cinq services tournent côte à
 * côte sur la machine. Dans un conteneur, `localhost` désigne le conteneur
 * lui-même — l'appel part vers un port où personne n'écoute. L'oubli ne se voit
 * alors ni au démarrage ni dans les sondes de santé (elles ne testent que le
 * service lui-même), mais des jours plus tard, sur un `fetch failed` d'un job de
 * fond ou, pire, sur un nettoyage best-effort qui échoue en silence.
 *
 * D'où l'échec au plus tôt : le conteneur ne démarre pas, le déploiement n'atteint
 * jamais l'état sain et `scripts/deploy.sh` revient tout seul au commit précédent.
 *
 * L'environnement est passé explicitement plutôt que lu depuis `process.env` :
 * ce paquet est aussi consommé par le front, et la fonction reste testable.
 */
export function verifierUrlsServices(
  noms: readonly NomUrlService[],
  env: Record<string, string | undefined>,
): void {
  if (env.NODE_ENV !== 'production') return;
  const manquantes = noms.filter((nom) => !env[nom]?.trim());
  if (manquantes.length === 0) return;
  throw new Error(
    `Configuration incomplète : ${manquantes.join(', ')} manquante(s). ` +
      'Les appels internes partiraient sur localhost, ' +
      'c’est-à-dire sur le conteneur lui-même (voir docker-compose.yml).',
  );
}
