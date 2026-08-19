#!/usr/bin/env bash
#
# Verifies the CouchDB JWT behaviours the authentication design depends on.
#
# WHY THIS SCRIPT EXISTS
# ----------------------
# Replication authenticates browser-to-CouchDB directly, with CouchDB validating our ES256
# tokens itself. Three things must hold, and none is obvious from the documentation:
#
#   1. CouchDB validates ES256 (EC P-256), not only RSA and HMAC.
#   2. Bad tokens are genuinely refused - expired, wrong key, edited payload.
#   3. `[jwt_keys]` is applied LIVE. Adding a key under a new `kid` takes effect on the next
#      request, and old and new keys coexist. This is what makes zero-downtime key rotation
#      possible, and the design assumes it.
#
# Note the asymmetry, which is easy to get backwards: `[chttpd] authentication_handlers` is
# read only at STARTUP, while `[jwt_keys]` is live. Setting the handler at runtime returns
# 200 and does nothing until restart - and until then every request authenticates as
# ANONYMOUS rather than failing, which looks exactly like a permissions bug. Production bakes
# the handler into the image (infra/couchdb/local.ini) so it is present at boot; this script
# configures it and restarts once as setup, then asserts the live behaviours.
#
# Requires: node, openssl, curl, jq, docker.
#
# Usage:
#   COUCHDB_URL=http://localhost:5985 COUCHDB_CONTAINER=matter-manager-dev-couchdb-1 \
#   COUCHDB_ADMIN_USER=admin COUCHDB_ADMIN_PASSWORD=devonly \
#     ./infra/couchdb/verify-jwt-model.sh

set -euo pipefail

URL="${COUCHDB_URL:-http://localhost:5985}"
ADMIN="${COUCHDB_ADMIN_USER:-admin}:${COUCHDB_ADMIN_PASSWORD:-devonly}"
CONTAINER="${COUCHDB_CONTAINER:-matter-manager-dev-couchdb-1}"
DB="verify-jwt-$$"
WORK="$(mktemp -d)"

pass=0
fail=0

cleanup() {
  curl -s -u "$ADMIN" -X DELETE "$URL/$DB" >/dev/null 2>&1 || true
  for k in "jwt_keys/ec:_default" "jwt_keys/ec:vjm-rotated" "jwt_auth/required_claims" \
           "chttpd/authentication_handlers"; do
    curl -s -u "$ADMIN" -X DELETE "$URL/_node/_local/_config/$k" >/dev/null 2>&1 || true
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

assert() {
  if printf '%s' "$2" | grep -q "$3"; then
    printf '  ok   %s\n' "$1"; pass=$((pass + 1))
  else
    printf '  FAIL %s\n       expected to contain: %s\n       got: %s\n' "$1" "$3" "$2"
    fail=$((fail + 1))
  fi
}

wait_up() {
  # Bounded on purpose: an unbounded loop turns a failed `docker restart` into a job that
  # hangs until the runner timeout, with nothing in the log explaining why.
  for _ in $(seq 1 60); do
    curl -s -m 2 "$URL/_up" >/dev/null 2>&1 && return 0
    sleep 1
  done
  printf '  FAIL CouchDB did not become available within 60s\n'
  exit 1
}

# CouchDB config values cannot contain real newlines: PEM line breaks go in as the two
# characters backslash + n, which is \\n once JSON-encoded.
put_key() {
  awk '{printf "%s\\n", $0}' "$2" | tr -d '\n' | jq -Rs . > "$WORK/k.json"
  curl -s -u "$ADMIN" -X PUT "$URL/_node/_local/_config/jwt_keys/$1" \
    -H 'Content-Type: application/json' --data-binary @"$WORK/k.json" >/dev/null
}

printf 'Verifying CouchDB JWT model at %s\n' "$URL"
printf 'CouchDB version: %s\n\n' "$(curl -s "$URL/" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)"

cat > "$WORK/mkjwt.mjs" <<'EOF'
import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url')
const [, , keyPath, sub, offset, kid] = process.argv
const h = b64(kid ? { alg: 'ES256', typ: 'JWT', kid } : { alg: 'ES256', typ: 'JWT' })
const p = b64({ sub, exp: Math.floor(Date.now() / 1000) + Number(offset ?? 3600) })
const s = createSign('SHA256')
s.update(`${h}.${p}`)
// JOSE wants the raw R||S pair; Node emits DER unless told otherwise.
process.stdout.write(`${h}.${p}.${s.sign({ key: readFileSync(keyPath, 'utf8'), dsaEncoding: 'ieee-p1363' }).toString('base64url')}`)
EOF

openssl ecparam -name prime256v1 -genkey -noout -out "$WORK/ec.pem" 2>/dev/null
openssl ec -in "$WORK/ec.pem" -pubout -out "$WORK/ec.pub" 2>/dev/null
openssl ecparam -name prime256v1 -genkey -noout -out "$WORK/other.pem" 2>/dev/null
openssl ecparam -name prime256v1 -genkey -noout -out "$WORK/rot.pem" 2>/dev/null
openssl ec -in "$WORK/rot.pem" -pubout -out "$WORK/rot.pub" 2>/dev/null

# --- setup: enable the handler and restart once, because that setting is startup-only ---
curl -s -u "$ADMIN" -X PUT "$URL/_node/_local/_config/jwt_auth/required_claims" -d '"exp"' >/dev/null
curl -s -u "$ADMIN" -X PUT "$URL/_node/_local/_config/chttpd/authentication_handlers" \
  -d '"{chttpd_auth, jwt_authentication_handler}, {chttpd_auth, default_authentication_handler}"' >/dev/null
put_key "ec:_default" "$WORK/ec.pub"
printf '  ..   restarting %s (authentication_handlers is read at startup)\n' "$CONTAINER"
docker restart "$CONTAINER" >/dev/null
wait_up

curl -s -u "$ADMIN" -X PUT "$URL/$DB" >/dev/null
curl -s -u "$ADMIN" -X PUT "$URL/$DB/_security" -H 'Content-Type: application/json' \
  -d '{"members":{"names":["vjm-member"],"roles":[]},"writers":{"names":["vjm-member"]}}' >/dev/null
curl -s -u "$ADMIN" -X PUT "$URL/$DB/doc1" -H 'Content-Type: application/json' \
  -d '{"type":"device","name":"hello"}' >/dev/null

TOKEN=$(node "$WORK/mkjwt.mjs" "$WORK/ec.pem" vjm-member)

assert "an ES256 token authenticates" \
  "$(curl -s -H "Authorization: Bearer $TOKEN" "$URL/$DB/doc1")" '"name":"hello"'

assert "an ES256 token authorises a write" \
  "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -d '{"type":"device","name":"written"}' "$URL/$DB/doc2")" '"ok":true'

assert "a valid token for a non-member is refused" \
  "$(curl -s -H "Authorization: Bearer $(node "$WORK/mkjwt.mjs" "$WORK/ec.pem" vjm-outsider)" "$URL/$DB/doc1")" \
  'not allowed to access'

assert "a token signed by a different key is refused" \
  "$(curl -s -H "Authorization: Bearer $(node "$WORK/mkjwt.mjs" "$WORK/other.pem" vjm-member)" "$URL/$DB/doc1")" \
  'Bad signature'

assert "an expired token is refused" \
  "$(curl -s -H "Authorization: Bearer $(node "$WORK/mkjwt.mjs" "$WORK/ec.pem" vjm-member -60)" "$URL/$DB/doc1")" \
  'exp not in future'

# Edit the payload, keep the original signature.
# NOTE: do NOT "tamper" by changing the last character of the signature. An ES256 signature
# is 64 bytes in 86 base64url characters, so the final character carries discarded padding
# bits and the edit can decode to identical bytes - making a forgery test silently pass.
FORGED=$(node -e '
const [h,p,s] = process.argv[1].split(".")
const pl = JSON.parse(Buffer.from(p, "base64url")); pl.sub = "vjm-member"
process.stdout.write(`${h}.${Buffer.from(JSON.stringify(pl)).toString("base64url")}.${s}`)
' "$(node "$WORK/mkjwt.mjs" "$WORK/ec.pem" vjm-outsider)")
assert "a token whose payload was edited is refused" \
  "$(curl -s -H "Authorization: Bearer $FORGED" "$URL/$DB/doc1")" 'Bad signature'

# --- the rotation contract: keys are live, and coexist ---
put_key "ec:vjm-rotated" "$WORK/rot.pub"

assert "a key added under a new kid works WITHOUT a restart" \
  "$(curl -s -H "Authorization: Bearer $(node "$WORK/mkjwt.mjs" "$WORK/rot.pem" vjm-member 3600 vjm-rotated)" "$URL/$DB/doc1")" \
  '"name":"hello"'

assert "the previous key still validates, so rotation needs no downtime" \
  "$(curl -s -H "Authorization: Bearer $TOKEN" "$URL/$DB/doc1")" '"name":"hello"'

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
