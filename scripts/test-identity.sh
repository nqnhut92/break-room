#!/usr/bin/env bash
# All services and data are disposable. Never reads DATABASE_URL/REDIS_URL.
set -euo pipefail
runtime=""
for r in podman docker; do if command -v "$r" >/dev/null; then runtime="$r"; break; fi; done
[ -n "$runtime" ] || { echo 'Docker or podman is required' >&2; exit 1; }
pg_name="br-identity-pg-$$"; redis_name="br-identity-redis-$$"
cleanup() { "$runtime" rm -f "$pg_name" "$redis_name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
"$runtime" run -d --rm --name "$pg_name" -e POSTGRES_PASSWORD=local-test-only -e POSTGRES_DB=breakroom -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
"$runtime" run -d --rm --name "$redis_name" -p 127.0.0.1::6379 redis:7-alpine redis-server --save '' --appendonly no >/dev/null
for _ in $(seq 1 60); do if "$runtime" exec "$pg_name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi; sleep 0.5; done
pg_port=$("$runtime" port "$pg_name" 5432/tcp | sed 's/.*://')
redis_port=$("$runtime" port "$redis_name" 6379/tcp | sed 's/.*://')
IDENTITY_TEST_DATABASE_URL="postgres://postgres:local-test-only@127.0.0.1:$pg_port/breakroom" IDENTITY_TEST_REDIS_URL="redis://127.0.0.1:$redis_port" node test/identity.js
