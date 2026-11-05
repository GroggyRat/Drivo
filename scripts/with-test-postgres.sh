#!/usr/bin/env bash
# Runs a command with TEST_DATABASE_URL pointing at a throwaway Postgres server.
#
#   scripts/with-test-postgres.sh npx vitest run --project db
#
# If TEST_DATABASE_URL is already set (for example in CI), the command runs
# against that server instead and nothing is started here.
set -euo pipefail

if [[ -n "${TEST_DATABASE_URL:-}" ]]; then
  exec "$@"
fi

if command -v initdb >/dev/null 2>&1; then
  PG_BIN="$(dirname "$(command -v initdb)")"
else
  PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
fi
if [[ -z "${PG_BIN}" || ! -x "${PG_BIN}/initdb" ]]; then
  echo "Postgres server binaries not found. Install Postgres 15+ with PostGIS (for example postgresql-16-postgis-3) or set TEST_DATABASE_URL." >&2
  exit 1
fi

PORT="${TEST_PG_PORT:-54329}"
DATA_DIR="$(mktemp -d)"

# initdb refuses to run as root, so drop to the postgres user when needed.
run_pg() {
  if [[ "$(id -u)" == "0" ]]; then
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}

if [[ "$(id -u)" == "0" ]]; then
  chown postgres "${DATA_DIR}"
fi

cleanup() {
  run_pg "${PG_BIN}/pg_ctl" -D "${DATA_DIR}" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "${DATA_DIR}"
}
trap cleanup EXIT

run_pg "${PG_BIN}/initdb" -D "${DATA_DIR}" -U postgres --auth=trust >/dev/null
run_pg "${PG_BIN}/pg_ctl" -D "${DATA_DIR}" -l "${DATA_DIR}/server.log" \
  -o "-p ${PORT} -c listen_addresses=localhost -k ${DATA_DIR}" -w start >/dev/null

export TEST_DATABASE_URL="postgresql://postgres@localhost:${PORT}/postgres"
"$@"
