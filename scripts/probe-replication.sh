#!/usr/bin/env bash
#
# Proves, against the live deployment, that a document written through `/db` replicates — the
# one part of the Pages Functions work that no test and no unauthenticated probe can reach.
#
# Everything under it is already proven without a credential: `require_valid_user` is in force,
# the forwarder carries `Authorization` (a malformed bearer produces CouchDB's "Malformed
# token" rather than "Authentication required"), and `ec:$JWT_KEY_ID` is installed and usable
# in `[jwt_keys]` (a wrongly-signed token with that kid produces "Bad signature", while an
# unknown kid produces "Unknown kid"). What remains is the positive case, and that needs a
# token somebody actually signed.
#
# **The token never leaves this script.** It is read from the file the mint step wrote, held in
# a shell variable, and only ever sent in a header. Nothing here prints it, and the output is
# statuses and CouchDB's own reasons. That is deliberate: the signing keys were generated on
# the droplet and have never been on this machine, and this script is not the thing that
# changes that.
#
#   Usage:  bash scripts/probe-replication.sh
#
#   Expects /tmp/mm-session.jwt to hold a session token minted on the droplet with the API's
#   own `mintToken`, for a throwaway subject:
#
#     ssh wisselroot 'docker exec -i matter-manager-api node --input-type=module' \
#       > /tmp/mm-session.jwt <<'JS'
#     import { signingKeyFromPem, mintToken } from '/app/dist/src/auth/jwt.js'
#     const now = Math.floor(Date.now() / 1000)
#     const key = signingKeyFromPem(process.env.JWT_KEY_ID + '-session', process.env.JWT_SESSION_PRIVATE_KEY)
#     console.log(mintToken(key, { purpose: 'session', sub: 'replication-probe', exp: now + 1800, iat: now }))
#     JS
#
# It creates a project and archives it again. That is a real write to production, which is why
# the name says what it is and the cleanup runs from a trap rather than from the happy path.
# Archiving is as far as the API goes - there is no DELETE for a project - so a run leaves an
# archived entry behind by design, and the database with it.

set -uo pipefail

ORIGIN=${ORIGIN:-https://app.matter-manager.io}
SESSION_FILE=${SESSION_FILE:-/tmp/mm-session.jwt}
WORK=$(mktemp -d)
PROJECT_ID=''

# From a trap, so a failure halfway through still takes the project with it. Without this, a
# probe that breaks after provisioning leaves a database behind in production and the next run
# is diagnosing its own litter.
cleanup() {
  if [ -n "${PROJECT_ID}" ]; then
    # Archived, not deleted. There is no DELETE route - projects carry an `archived` flag and
    # `GET /projects` returns them either way, which is a deliberate choice about a catalogue
    # somebody may still need to read. An earlier version of this script assumed a DELETE and
    # got a 404, leaving its probe project sitting in production.
    printf '\n%-52s' 'cleanup: archiving the probe project'
    curl -sS -o "${WORK}/arch" -w '%{http_code}\n' -m 20 -X PATCH \
      -H "Authorization: Bearer ${ACCESS:-}" -H 'Content-Type: application/json' \
      -d '{"archived":true}' "${ORIGIN}/api/projects/${PROJECT_ID}"
  fi
  rm -rf "${WORK}"
}
trap cleanup EXIT

# `-w` on its own line so the body stays in a file and only the status reaches the terminal.
# Every call in this script reports the same way, so a reader compares like with like.
call() {
  local method=$1 url=$2 out=$3
  shift 3
  curl -sS -o "${out}" -w '%{http_code}' -m 20 -X "${method}" "$@" "${url}"
}

say() { printf '%-52s' "$1"; }
reason() { node -pe "try{const r=JSON.parse(require('fs').readFileSync('$1','utf8'));r.reason||r.error||r.title||r.ok&&'ok'||''}catch{''}" 2>/dev/null; }

if [ ! -s "${SESSION_FILE}" ]; then
  echo "No session token at ${SESSION_FILE}. See the usage note at the top of this file." >&2
  exit 1
fi

echo "Probing ${ORIGIN}"
echo

# 1. The session cookie has to cross the /api forwarder for this to work at all. A forwarder
#    that dropped Cookie would answer 401 here, and the whole sign-in design would be broken in
#    a way no unauthenticated probe can see.
say 'POST /api/auth/token (cookie crosses /api)'
status=$(call POST "${ORIGIN}/api/auth/token" "${WORK}/token" \
  -b "mm_session=$(tr -d '\n' < "${SESSION_FILE}")")
echo "${status}"
[ "${status}" = "200" ] || { echo "  could not get an access token; stopping" >&2; exit 1; }

ACCESS=$(node -pe "JSON.parse(require('fs').readFileSync('${WORK}/token','utf8')).accessToken")
say '  token purpose / subject'
node -pe "const p=JSON.parse(Buffer.from('${ACCESS}'.split('.')[1],'base64url'));p.purpose+' / '+p.sub"

# 2. The positive case CouchDB has never been shown: a signature that verifies.
say 'GET /db/ with a signed token'
status=$(call GET "${ORIGIN}/db/" "${WORK}/root" -H "Authorization: Bearer ${ACCESS}")
echo "${status} $(reason "${WORK}/root")"

say 'GET /db/_session (who CouchDB thinks we are)'
status=$(call GET "${ORIGIN}/db/_session" "${WORK}/sess" -H "Authorization: Bearer ${ACCESS}")
echo "${status} $(node -pe "try{const s=JSON.parse(require('fs').readFileSync('${WORK}/sess','utf8'));(s.userCtx&&s.userCtx.name)||''}catch{''}" 2>/dev/null)"

# 3. A project, because the browser never creates a database itself: the API provisions it with
#    admin credentials and writes a _security document naming the user. Replicating into a
#    database the token is not named in is the failure this step would otherwise miss.
say 'POST /api/projects (provisions a database)'
status=$(call POST "${ORIGIN}/api/projects" "${WORK}/project" \
  -H "Authorization: Bearer ${ACCESS}" -H 'Content-Type: application/json' \
  -d '{"name":"Replication probe — safe to delete"}')
echo "${status}"
[ "${status}" = "201" ] || [ "${status}" = "200" ] || {
  echo "  $(cat "${WORK}/project")" >&2; exit 1; }

PROJECT_ID=$(node -pe "JSON.parse(require('fs').readFileSync('${WORK}/project','utf8')).projectId")
DB=$(node -pe "JSON.parse(require('fs').readFileSync('${WORK}/project','utf8')).dbName")
say '  database'
echo "${DB}"

# 4. The round trip PouchDB actually performs. Not a single GET: replication reads `_changes`,
#    writes with a revision, and reads back — and `_changes` is the one that would expose a
#    forwarder mangling the query string, which no other call here would notice.
# `type` is required by `infra/couchdb/design-docs/access.js`, which also checks the caller
# against the `_security` writers the API wrote. A document without it is refused with 403, so
# this call proves the design document is deployed and enforcing as well as that the write
# crosses - which is how the first run of this script found it, by getting it wrong.
say 'PUT /db/<db>/probe-doc (design doc enforces)'
status=$(call PUT "${ORIGIN}/db/${DB}/probe-doc" "${WORK}/put" \
  -H "Authorization: Bearer ${ACCESS}" -H 'Content-Type: application/json' \
  -d '{"type":"probe","note":"written through the Pages Function"}')
echo "${status} $(reason "${WORK}/put")"

say 'GET /db/<db>/probe-doc'
status=$(call GET "${ORIGIN}/db/${DB}/probe-doc" "${WORK}/got" -H "Authorization: Bearer ${ACCESS}")
echo "${status} $(node -pe "try{JSON.parse(require('fs').readFileSync('${WORK}/got','utf8')).note}catch{''}" 2>/dev/null)"

say 'GET /db/<db>/_changes?since=0 (query string)'
status=$(call GET "${ORIGIN}/db/${DB}/_changes?since=0&limit=10" "${WORK}/changes" \
  -H "Authorization: Bearer ${ACCESS}")
echo "${status} $(node -pe "try{JSON.parse(require('fs').readFileSync('${WORK}/changes','utf8')).results.length+' change(s)'}catch{''}" 2>/dev/null)"

say 'POST /db/<db>/_bulk_docs (what sync writes)'
status=$(call POST "${ORIGIN}/db/${DB}/_bulk_docs" "${WORK}/bulk" \
  -H "Authorization: Bearer ${ACCESS}" -H 'Content-Type: application/json' \
  -d '{"docs":[{"_id":"probe-bulk","type":"probe"}]}')
echo "${status} $(node -pe "try{const r=JSON.parse(require('fs').readFileSync('${WORK}/bulk','utf8'));r.map(d=>d.ok?'ok':(d.error||'?')).join(', ')}catch(e){''}" 2>/dev/null)"

# 5. The blocklist has to survive the new path. `/db` reaches CouchDB through the same host
#    Caddy as `couch.matter-manager.io`, and inheriting that `@forbidden` list rather than
#    keeping a second copy was the access-control decision the whole design rests on.
echo
for path in _all_dbs _utils/ _membership _cluster_setup; do
  say "GET /db/${path} (Caddy blocklist)"
  call GET "${ORIGIN}/db/${path}" "${WORK}/blocked" -H "Authorization: Bearer ${ACCESS}"
  echo
done
