#!/usr/bin/env sh
set -eu
: "${BACKUP_FILE:?BACKUP_FILE required}" "${DRILL_DATABASE_URL:?DRILL_DATABASE_URL required (isolated empty drill database)}"
test -f "$BACKUP_FILE.sha256" || { echo 'Backup checksum is required.' >&2; exit 1; }
(cd "$(dirname "$BACKUP_FILE")" && sha256sum --check "$(basename "$BACKUP_FILE").sha256")
objects=$(psql --set ON_ERROR_STOP=1 --tuples-only --no-align --dbname="$DRILL_DATABASE_URL" -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f');")
test "$objects" = 0 || { echo 'Restore drill database must be empty.' >&2; exit 1; }
pg_restore --exit-on-error --no-owner --no-acl --dbname="$DRILL_DATABASE_URL" "$BACKUP_FILE"
migrations=$(psql --set ON_ERROR_STOP=1 --tuples-only --no-align --dbname="$DRILL_DATABASE_URL" -c 'SELECT COUNT(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL;')
sites=$(psql --set ON_ERROR_STOP=1 --tuples-only --no-align --dbname="$DRILL_DATABASE_URL" -c 'SELECT COUNT(*) FROM "Site";')
test "${migrations:-0}" -gt 0
printf 'Restore drill passed: finished_migrations=%s sites=%s database=<isolated database URL redacted>\n' "$migrations" "$sites"
