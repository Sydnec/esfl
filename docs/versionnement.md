# Versionnement

**Source de vérité : le champ `version` du `package.json` racine.** C'est le
numéro du produit. Les `package.json` des workspaces sont privés et ne sont
jamais publiés : leur `version` ne veut rien dire, ne pas y toucher.

## Incrémenter à chaque changement

Toute modification du code applicatif incrémente la version **dans le même
commit** que le changement. Pas de commit de version séparé : un numéro qui
arrive après coup ne désigne plus rien de précis.

Le projet est en `0.x` — la compatibilité n'est pas encore promise, donc :

| Incrément           | Quand                                                       |
| ------------------- | ----------------------------------------------------------- |
| `0.x.Y` **patch**   | Correction : le comportement attendu ne change pas.         |
| `0.X.0` **mineure** | Nouveauté, ou changement visible côté joueur ou admin.      |
| `X.0.0` **majeure** | Réservée à la première version stable. Ne pas décider seul. |

N'incrémentent **pas** : documentation, commentaires, tests seuls, CI, mise en
forme. Rien de tout cela ne change ce qui tourne en production.

Deux branches qui déplacent le même numéro entrent en conflit sur
`package.json` : c'est voulu. La seconde mergée repart du numéro le plus élevé
et l'incrémente selon sa propre nature.

## Ce qui est automatique

Le **commit court** est injecté à la construction des images
(`scripts/deploy.sh` → `x-identite-build` du compose → `ARG`/`ENV` du
Dockerfile). Il n'y a rien à écrire à la main : c'est lui qui distingue deux
builds portant le même numéro de version.

## Vérifier ce qui tourne

- Page admin, en en-tête : `API v0.2.0 · a1b2c3d`.
- Ou directement : `curl https://api-esfl.simonbourlier.fr/health`.

Les cinq services renvoient le couple version + commit sur leur propre
`/health` ; ils sont construits ensemble et portent donc le même. Une
divergence entre deux services signale un déploiement partiel — voir
« Supervision des conteneurs » dans [DEPLOY.md](../DEPLOY.md).

Hors conteneur (développement), rien n'injecte ces variables et `/health`
répond `dev` / `local` : le code exécuté est celui du répertoire de travail,
pas un build identifiable.
