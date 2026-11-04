#!/usr/bin/env bash
# Runs `npm test` with the Redis part enabled, using a throwaway Redis container (podman or docker).
# Not needed if `redis-server` is installed: npm test then starts its own. The container is removed afterwards.
set -euo pipefail

RUNTIME=""
for r in podman docker; do
  if command -v "$r" >/dev/null 2>&1; then RUNTIME="$r"; break; fi
done
if [ -z "$RUNTIME" ]; then
  echo "Neither podman nor docker found. Install redis-server instead, or set TEST_REDIS_URL." >&2
  exit 1
fi

NAME="br-test-redis-$$"
PORT="${TEST_REDIS_PORT:-6390}"
cleanup() { "$RUNTIME" rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

"$RUNTIME" run -d --rm --name "$NAME" -p "127.0.0.1:$PORT:6379" docker.io/library/redis:7-alpine \
  redis-server --save "" --appendonly no >/dev/null
for _ in $(seq 1 30); do
  if "$RUNTIME" exec "$NAME" redis-cli ping 2>/dev/null | grep -q PONG; then break; fi
  sleep 0.3
done

TEST_REDIS_URL="redis://127.0.0.1:$PORT" npm test
