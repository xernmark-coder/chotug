#!/usr/bin/env bash
# Regenerate db/SCHEMA.sql — one file that creates the whole database.
#
# The MIGRATIONS are the source of truth: db/01…53 applied in the order
# server/src/scripts/migrate.ts names, which is how an existing database is
# brought forward without losing what is in it. This file is a snapshot of
# where they arrive, for standing a new one up in a single step.
#
# Regenerate it after adding a migration, from a database that has run them all:
#     ./scripts/dump-schema.sh
set -euo pipefail
DB="${1:-postgres://chotug:chotug@localhost:5432/chotug_erp}"
OUT="$(dirname "$0")/../db/SCHEMA.sql"

pg_dump "$DB" --schema-only --no-owner --no-privileges -f "$OUT"

printf 'db/SCHEMA.sql · %s tables · %s views · %s functions · %s triggers\n' \
  "$(grep -c 'CREATE TABLE' "$OUT")" "$(grep -c 'CREATE VIEW' "$OUT")" \
  "$(grep -c 'CREATE FUNCTION' "$OUT")" "$(grep -c 'CREATE TRIGGER' "$OUT")"
