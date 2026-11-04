#!/usr/bin/env bash
# Runs the migrations and the SQL tests against a throwaway local Postgres.
# Needs the Postgres server binaries (initdb, pg_ctl); no Supabase or Docker.
#   supabase/tests/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bin="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$bin/initdb" ] || { echo "initdb not found; set PG_BIN"; exit 1; }
tmp="$(mktemp -d)"
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
[ "$(id -u)" = 0 ] && chown postgres "$tmp"
cleanup() { run "'$bin/pg_ctl' -D '$tmp/data' -m immediate stop" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT
run "'$bin/initdb' -D '$tmp/data' -U postgres -A trust" >/dev/null
run "'$bin/pg_ctl' -D '$tmp/data' -o \"-k '$tmp' -p 55432 -c listen_addresses=''\" -l '$tmp/log' -w start" >/dev/null
psql=(psql -h "$tmp" -p 55432 -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X -t)
"${psql[@]}" -f "$here/stub_supabase.sql"
for m in "$here"/../migrations/*.sql; do "${psql[@]}" -f "$m"; done
for t in "$here"/*_test.sql; do echo "== $(basename "$t")"; "${psql[@]}" -f "$t"; done
echo "All SQL tests passed."
