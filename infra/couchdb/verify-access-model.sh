#!/usr/bin/env bash
#
# Verifies the CouchDB behaviours the entire authorization model depends on.
#
# WHY THIS SCRIPT EXISTS
# ----------------------
# Project sharing rests on two CouchDB behaviours that are not prominently documented
# and are not covered by any test we own:
#
#   1. `_security` preserves keys CouchDB does not itself interpret (we add `writers`).
#   2. `validate_doc_update` receives the whole `_security` object as its 4th argument.
#
# If either stops being true after a CouchDB upgrade, read-only project access silently
# becomes read-write. That is a privilege escalation that no application-level test would
# catch, because the application would be behaving exactly as written.
#
# Run this against every CouchDB version before adopting it.
#
# Usage:
#   COUCHDB_URL=http://localhost:5985 \
#   COUCHDB_ADMIN_USER=admin COUCHDB_ADMIN_PASSWORD=devonly \
#     ./infra/couchdb/verify-access-model.sh

set -euo pipefail

URL="${COUCHDB_URL:-http://localhost:5985}"
ADMIN="${COUCHDB_ADMIN_USER:-admin}:${COUCHDB_ADMIN_PASSWORD:-devonly}"
DB="verify-access-model-$$"
PW='verify-only-pw'
WORK_DD="$(mktemp)"

pass=0
fail=0

cleanup() {
  rm -f "$WORK_DD"
  curl -s -u "$ADMIN" -X DELETE "$URL/$DB" >/dev/null 2>&1 || true
  for u in "vam-writer" "vam-reader" "vam-outsider"; do
    rev=$(curl -s -u "$ADMIN" "$URL/_users/org.couchdb.user:$u" | grep -o '"_rev":"[^"]*"' | cut -d'"' -f4 || true)
    [ -n "$rev" ] && curl -s -u "$ADMIN" -X DELETE "$URL/_users/org.couchdb.user:$u?rev=$rev" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

# assert <description> <haystack> <needle>
assert() {
  if printf '%s' "$2" | grep -q "$3"; then
    printf '  ok   %s\n' "$1"
    pass=$((pass + 1))
  else
    printf '  FAIL %s\n       expected to contain: %s\n       got: %s\n' "$1" "$3" "$2"
    fail=$((fail + 1))
  fi
}

printf 'Verifying CouchDB access model at %s\n' "$URL"
printf 'CouchDB version: %s\n\n' "$(curl -s "$URL/" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)"

cleanup
curl -s -u "$ADMIN" -X PUT "$URL/$DB" >/dev/null
for u in vam-writer vam-reader vam-outsider; do
  curl -s -u "$ADMIN" -X PUT "$URL/_users/org.couchdb.user:$u" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$u\",\"password\":\"$PW\",\"roles\":[],\"type\":\"user\"}" >/dev/null
done

curl -s -u "$ADMIN" -X PUT "$URL/$DB/_security" -H 'Content-Type: application/json' \
  -d '{"members":{"names":["vam-writer","vam-reader"],"roles":[]},"writers":{"names":["vam-writer"]}}' >/dev/null

# Install the REAL validation function, read from design-docs/access.js.
#
# It used to be hand-copied into this script as a string. That is how a hole survived:
# access.js returned early on _deleted before the audit check, so audit entries could be
# deleted - and this script's copy had the same bug, so it asserted the code was correct
# against a duplicate of the same mistake. A verifier that tests a copy of the subject
# tests nothing.
node -e '
const fs = require("fs")
const src = fs.readFileSync(process.argv[1], "utf8")
const start = src.indexOf("function (")
if (start === -1) { console.error("no function found in access.js"); process.exit(1) }
fs.writeFileSync(process.argv[2], JSON.stringify({ validate_doc_update: src.slice(start) }))
' "$(dirname "$0")/design-docs/access.js" "$WORK_DD"

curl -s -u "$ADMIN" -X PUT "$URL/$DB/_design/access" \
  -H 'Content-Type: application/json' --data-binary @"$WORK_DD" >/dev/null

assert "_security preserves the non-standard 'writers' key" \
  "$(curl -s -u "$ADMIN" "$URL/$DB/_security")" '"writers"'

assert "a writer can create a document" \
  "$(curl -s -u "vam-writer:$PW" -X PUT "$URL/$DB/device:1" -H 'Content-Type: application/json' -d '{"type":"device","name":"Kitchen light"}')" \
  '"ok":true'

assert "a reader cannot create a document" \
  "$(curl -s -u "vam-reader:$PW" -X PUT "$URL/$DB/device:2" -H 'Content-Type: application/json' -d '{"type":"device","name":"Hallway sensor"}')" \
  'read-only access'

assert "a reader CAN read a document" \
  "$(curl -s -u "vam-reader:$PW" "$URL/$DB/device:1")" '"name":"Kitchen light"'

# `|| true` because a failed read makes grep exit 1, and `set -o pipefail` would then abort
# the whole script instead of letting the assertion below report a failure.
rev=$(curl -s -u "vam-reader:$PW" "$URL/$DB/device:1" | grep -o '"_rev":"[^"]*"' | cut -d'"' -f4 || true)
assert "a reader cannot delete a document (deletes are writes)" \
  "$(curl -s -u "vam-reader:$PW" -X DELETE "$URL/$DB/device:1?rev=$rev")" 'read-only access'

assert "a document without a type is rejected" \
  "$(curl -s -u "vam-writer:$PW" -X PUT "$URL/$DB/bad:1" -H 'Content-Type: application/json' -d '{"name":"no type"}')" \
  'must carry a'

curl -s -u "vam-writer:$PW" -X PUT "$URL/$DB/audit:1" -H 'Content-Type: application/json' -d '{"type":"audit","action":"created"}' >/dev/null
arev=$(curl -s -u "vam-writer:$PW" "$URL/$DB/audit:1" | grep -o '"_rev":"[^"]*"' | cut -d'"' -f4 || true)
assert "an audit entry cannot be EDITED" \
  "$(curl -s -u "vam-writer:$PW" -X PUT "$URL/$DB/audit:1" -H 'Content-Type: application/json' -d "{\"type\":\"audit\",\"action\":\"tampered\",\"_rev\":\"$arev\"}")" \
  'immutable'

# Deleting is the other way to mutate a log, and it was the one this suite missed. A CouchDB
# delete body is {_id, _rev, _deleted} with no `type`, so a validation function that reads
# newDoc.type lets every audit entry be removed while still passing the edit assertion above.
assert "an audit entry cannot be DELETED" \
  "$(curl -s -u "vam-writer:$PW" -X DELETE "$URL/$DB/audit:1?rev=$arev")" \
  'immutable'

assert "a non-member cannot read at all" \
  "$(curl -s -u "vam-outsider:$PW" "$URL/$DB/device:1")" 'not allowed to access'

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
