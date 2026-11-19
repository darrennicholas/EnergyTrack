#!/usr/bin/env sh
set -eu
: "${BACKUP_DIR:?BACKUP_DIR required}"
if [ -z "${DATABASE_URL:-}" ]; then : "${PGHOST:?PGHOST or DATABASE_URL required}" "${PGUSER:?PGUSER or DATABASE_URL required}" "${PGDATABASE:?PGDATABASE or DATABASE_URL required}"; fi
mkdir -p "$BACKUP_DIR"
name="energytrack-$(date -u +%Y%m%dT%H%M%SZ).dump"
if [ -n "${DATABASE_URL:-}" ]; then pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-acl --file="$BACKUP_DIR/$name"; else pg_dump --format=custom --no-owner --no-acl --file="$BACKUP_DIR/$name"; fi
find "$BACKUP_DIR" -type f \( -name 'energytrack-*.dump' -o -name 'energytrack-*.dump.sha256' \) -mtime +30 -delete
(cd "$BACKUP_DIR" && sha256sum "$name" > "$name.sha256")
echo "Created $BACKUP_DIR/$name"
