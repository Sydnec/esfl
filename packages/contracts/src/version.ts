/** Identité de la version en cours d'exécution, telle qu'exposée par `/health`. */
export interface IdentiteVersion {
  /** Version produit (`version` du package.json racine), au format semver. */
  version: string;
  /** Commit court réellement construit — ce qui distingue deux builds d'une même version. */
  commit: string;
}

/**
 * Lit l'identité de version injectée à la construction de l'image.
 *
 * La version seule ne suffit pas à répondre à « qu'est-ce qui tourne ? » : entre
 * deux publications, plusieurs commits portent le même numéro. Le couple
 * version + commit, lui, désigne un build et un seul.
 *
 * Les replis (`dev`, `local`) sont la réponse honnête hors conteneur : en
 * développement, rien n'injecte ces variables et le code exécuté est celui du
 * répertoire de travail, pas un build identifiable.
 */
export function identiteVersion(env: Record<string, string | undefined>): IdentiteVersion {
  return {
    version: env.APP_VERSION?.trim() || 'dev',
    commit: env.APP_COMMIT?.trim() || 'local',
  };
}
