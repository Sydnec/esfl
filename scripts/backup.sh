#!/bin/sh
# Sauvegarde de la base ESFL, en deux niveaux.
#
# Les 97 Mo de la base ne se valent pas : `data` et `scoring` se reconstruisent
# intégralement depuis Pandascore et les sources de stats (quelques heures
# d'ingestion), alors que `auth` et `fantasy` — comptes, ligues, rosters, picks
# — ne se reconstruisent pas du tout. Et ils pèsent 400 Ko.
#
# D'où deux rythmes :
#   - CRITIQUE (auth + fantasy) toutes les heures, conservé 30 jours. Coût
#     négligeable, c'est ce qui protège vraiment les utilisateurs.
#   - COMPLET toutes les 24 h, conservé 7 jours. Évite de rejouer des heures
#     d'ingestion après un incident, sans saturer le disque du VPS.
#
# Lancé en boucle par le service `backup` du docker-compose. Restauration :
# voir DEPLOY.md.
set -eu

DEST="${BACKUP_DIR:-/backups}"
HOTE="${PGHOST:-postgres}"
UTILISATEUR="${POSTGRES_USER:-esfl}"
BASE="${POSTGRES_DB:-esfl}"
RETENTION_COMPLET="${BACKUP_KEEP_FULL_DAYS:-7}"
RETENTION_CRITIQUE="${BACKUP_KEEP_CRITICAL_DAYS:-30}"

mkdir -p "$DEST"

# Taille en deçà de laquelle un dump ne peut pas être valide : même une base
# vide produit plusieurs kilo-octets d'en-têtes.
TAILLE_MIN=1024

dump() {
  nom="$1"
  shift
  base_nom="$DEST/esfl-$nom-$(date -u +%Y%m%d-%H%M).sql"

  # SURTOUT PAS `pg_dump | gzip` : en sh, un pipeline rend le code de sortie du
  # DERNIER maillon. gzip compresse très bien un flux vide, et le script
  # annoncerait un succès sur un dump échoué — une sauvegarde de 20 octets qu'on
  # ne découvre qu'au moment de restaurer. On écrit donc en clair d'abord, on
  # vérifie, puis on compresse.
  if ! pg_dump -h "$HOTE" -U "$UTILISATEUR" -d "$BASE" --clean --if-exists "$@" > "$base_nom.tmp"; then
    rm -f "$base_nom.tmp"
    echo "$(date -u +%FT%TZ) ÉCHEC de la sauvegarde $nom (pg_dump)" >&2
    return 1
  fi

  taille=$(wc -c < "$base_nom.tmp")
  if [ "$taille" -lt "$TAILLE_MIN" ]; then
    rm -f "$base_nom.tmp"
    echo "$(date -u +%FT%TZ) ÉCHEC de la sauvegarde $nom : $taille octets, dump vide" >&2
    return 1
  fi

  mv "$base_nom.tmp" "$base_nom"
  gzip -f "$base_nom"
  echo "$(date -u +%FT%TZ) sauvegarde $nom : $(du -h "$base_nom.gz" | cut -f1)"
}

purger() {
  find "$DEST" -name "esfl-$1-*.sql.gz" -mtime "+$2" -delete 2>/dev/null || true
}

# Un seul passage, pour lancer le script à la main ou depuis un cron externe.
if [ "${1:-}" = "--once" ]; then
  dump critique --schema=auth --schema=fantasy
  dump complet
  exit 0
fi

heures=0
while true; do
  dump critique --schema=auth --schema=fantasy || true
  purger critique "$RETENTION_CRITIQUE"

  if [ "$heures" -eq 0 ]; then
    dump complet || true
    purger complet "$RETENTION_COMPLET"
  fi

  heures=$(( (heures + 1) % 24 ))
  sleep 3600
done
