#!/bin/sh
# Déploiement de la production ESFL.
#
# Appelé par le workflow CD (.github/workflows/cd.yml) sur le runner
# self-hosted, mais volontairement autonome : lancé à la main, il reprend un
# déploiement échoué à l'identique. Toute la logique vit ici plutôt que dans le
# YAML, parce qu'un pipeline qu'on ne peut pas rejouer en local est un pipeline
# qu'on débogue à l'aveugle.
#
#   sh scripts/deploy.sh              # déploie origin/main
#   sh scripts/deploy.sh <sha>        # déploie un commit précis
#
# Séquence : sauvegarde → bascule du code → build → attente des sondes →
# test de fumée public. Tout échec après le build ramène au commit précédent.
set -eu

RACINE="${ESFL_DIR:-/home/sydnec/ESFL}"
ENV_FICHIER="${ESFL_ENV_FILE:-.env.prod}"
CIBLE="${1:-origin/main}"
SONDE_PUBLIQUE="${ESFL_HEALTH_URL:-https://api-esfl.simonbourlier.fr/health}"
# Le démarrage rejoue `prisma migrate deploy` et le gateway attend les quatre
# services sains : compter large, le compose lui-même pose start_period=60s.
ATTENTE_MAX="${ESFL_HEALTH_TIMEOUT:-300}"
SERVICES="gateway auth-service data-service fantasy-service scoring-service"

journal() {
  echo "$(date -u +%FT%TZ) $*"
}

compose() {
  docker compose --env-file "$ENV_FICHIER" "$@"
}

# Attend que les cinq services applicatifs soient `healthy`. Un conteneur qui
# meurt en boucle n'atteint jamais cet état : c'est le timeout qui tranche.
attendre_sante() {
  reste="$ATTENTE_MAX"
  while [ "$reste" -gt 0 ]; do
    tous_sains=1
    for service in $SERVICES; do
      cid=$(compose ps -q "$service" 2>/dev/null || true)
      if [ -z "$cid" ]; then
        tous_sains=0
        break
      fi
      etat=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}sans-sonde{{end}}' "$cid" 2>/dev/null || echo absent)
      if [ "$etat" != "healthy" ]; then
        tous_sains=0
        break
      fi
    done
    if [ "$tous_sains" -eq 1 ]; then
      journal "les $(echo "$SERVICES" | wc -w) services sont sains"
      return 0
    fi
    sleep 5
    reste=$((reste - 5))
  done
  journal "ÉCHEC : services toujours pas sains après ${ATTENTE_MAX}s"
  compose ps
  return 1
}

# Test de fumée à travers le tunnel Cloudflare, et non sur localhost : c'est la
# seule façon de voir une panne de tunnel ou de routage, invisible en interne.
# Quelques tentatives, le tunnel peut mettre un instant à réapparier.
fumee() {
  essai=1
  while [ "$essai" -le 5 ]; do
    if curl -fsS --max-time 10 "$SONDE_PUBLIQUE" > /dev/null 2>&1; then
      journal "test de fumée public OK ($SONDE_PUBLIQUE)"
      return 0
    fi
    journal "test de fumée : tentative $essai/5 sans réponse"
    sleep 6
    essai=$((essai + 1))
  done
  journal "ÉCHEC : $SONDE_PUBLIQUE ne répond pas"
  return 1
}

cd "$RACINE"

[ -f "$ENV_FICHIER" ] || {
  journal "ÉCHEC : $RACINE/$ENV_FICHIER introuvable — secrets de prod absents"
  exit 1
}

PRECEDENT=$(git rev-parse HEAD)
journal "commit courant : $PRECEDENT"

# Déterminer la cible avant toute autre chose : inutile de sauvegarder une base
# pour un déploiement qui n'a rien à déployer.
git fetch --quiet origin
NOUVEAU=$(git rev-parse "$CIBLE")
if [ "$NOUVEAU" = "$PRECEDENT" ]; then
  journal "déjà sur $NOUVEAU — rien à faire"
  exit 0
fi

# Sauvegarde AVANT la bascule : le démarrage des conteneurs applique
# `prisma migrate deploy`, qui ne se défait pas. Réutilise scripts/backup.sh,
# qui sait déjà refuser un dump vide (cf. le piège `pg_dump | gzip`).
journal "sauvegarde pré-migration"
if ! compose exec -T backup sh /backup.sh --once; then
  journal "ÉCHEC : sauvegarde impossible — déploiement annulé, rien n'a changé"
  exit 1
fi

journal "bascule $PRECEDENT -> $NOUVEAU"
git reset --hard --quiet "$NOUVEAU"

if compose up -d --build && attendre_sante && fumee; then
  journal "déploiement de $NOUVEAU réussi"
  # Les builds successifs empilent images et couches intermédiaires. Sans purge,
  # le disque de l'hôte finit par saturer et Postgres tombe en écriture.
  docker image prune -f > /dev/null 2>&1 || true
  docker builder prune -f > /dev/null 2>&1 || true
  exit 0
fi

# ATTENTION : ce retour arrière ramène le CODE, pas le schéma. Une migration
# Prisma déjà appliquée reste en place, et l'ancien code peut ne pas savoir la
# lire. Dans ce cas la restauration du dump pris ci-dessus est le vrai recours
# (voir la section « Sauvegarde et restauration » de DEPLOY.md).
journal "ÉCHEC du déploiement — retour arrière vers $PRECEDENT"
git reset --hard --quiet "$PRECEDENT"
if compose up -d --build && attendre_sante; then
  journal "retour arrière effectué : la prod tourne à nouveau sur $PRECEDENT"
else
  journal "ALERTE : le retour arrière a échoué lui aussi — intervention manuelle requise"
fi
exit 1
