import { verify } from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';

/**
 * Frontière de sécurité du système.
 *
 * Les services internes font confiance à `x-user-id` SANS revérifier le token :
 * c'est ici, et nulle part ailleurs, que l'identité est établie. Deux
 * propriétés en découlent, toutes deux couvertes par les tests.
 *
 * 1. Les en-têtes `x-user-*` entrants sont TOUJOURS supprimés, avant même de
 *    regarder le token. Sans cela, n'importe qui les poserait à la main et se
 *    ferait passer pour un admin.
 * 2. `isAdmin` doit valoir exactement `true`. Une comparaison lâche promouvrait
 *    admin tout token dont la claim est une chaîne non vide.
 * 3. L'en-tête `x-admin-token` entrant est supprimé : c'est le token d'ops que
 *    l'AdminGuard des services accepte en interne. Reçu du public, il ferait du
 *    gateway un chemin de brute-force vers les routes admin — il ne doit jamais
 *    transiter par le proxy.
 */
export function contexteUtilisateur(jwtSecret: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    delete req.headers['x-user-id'];
    delete req.headers['x-user-admin'];
    delete req.headers['x-admin-token'];

    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      try {
        const payload = verify(header.slice(7), jwtSecret) as {
          sub?: string;
          isAdmin?: boolean;
        };
        if (payload.sub) {
          req.headers['x-user-id'] = payload.sub;
          if (payload.isAdmin === true) {
            req.headers['x-user-admin'] = '1';
          }
        }
      } catch {
        // Token invalide, expiré ou signé d'une autre clé : la requête reste
        // anonyme. On ne distingue pas les cas, l'appelant n'a pas à savoir.
      }
    }
    next();
  };
}

/**
 * Les routes internes (purges, rosters bruts…) ne passent jamais par le
 * gateway : les services s'appellent en direct via `*_SERVICE_URL`. Exposées,
 * elles seraient atteignables sans aucun contrôle d'identité.
 */
export function bloquerRoutesInternes(req: Request, res: Response, next: NextFunction): void {
  if (req.path.includes('/internal/')) {
    res.status(404).end();
    return;
  }
  next();
}
