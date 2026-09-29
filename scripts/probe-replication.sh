#!/usr/bin/env bash
#
# Proves, against the live deployment, that a document written through `/db` survives the round
# trip — the one part of the Pages Functions work that no test and no unauthenticated probe can
# reach. See `docs/replication.md` for the rest of the chain and how it was established.
#
# Everything under it is already proven without a credential: `require_valid_user` is in force,
# the forwarder carries `Authorization` (a malformed bearer produces CouchDB's "Malformed
# token" rather than "Authentication required"), and `ec:$JWT_KEY_ID` is installed and usable
# in `[jwt_keys]` (a wrongly-signed token with that kid produces "Bad signature", while an
# unknown kid produces "Unknown kid"). What remains is the positive case, and that needs a
# token somebody actually signed.
#
# **The token never reaches a process argument.** `ps` is readable by other local users on most
# systems, so a credential in `curl -H "Authorization: ..."` is a credential published to
# everyone logged in. It is written instead into a curl configuration file inside a private
# temporary directory, by node, straight from the response body — so it is never a shell
# variable either, and `-K` is what puts it on the wire. The signing keys themselves have never
# left the droplet, and this script is not the thing that changes that.
#
#   Usage:  bash scripts/probe-replication.sh
#
#   Expects /tmp/mm-session.jwt to hold a session token minted on the droplet. The mint command
#   is in `docs/replication.md`, and it sets `umask 077` first — a plain redirect would create a
#   live credential with whatever the caller's umask allows, which on a default 022 is
#   world-readable.
#
# It creates a project and archives it again. That is a real write to production, which is why
# the name says what it is and the cleanup runs from a trap rather than from the happy path.
# Archiving is as far as the API goes — there is no DELETE for a project — so a run leaves an
# archived entry behind by design, and the database with it.
#
# **Exit status is the point.** An earlier version printed every result and exited 0 regardless,
# so its first run reported a 403 write and a 404 read-back and still looked like a pass. This
# one exits non-zero unless the document written is the document read back.

set -uo pipefail

# Before anything creates a file. Everything below lands in a private directory anyway; this is
# the belt to that pair of braces and costs nothing.
umask 077

ORIGIN=${ORIGIN:-https://app.matter-manager.io}
SESSION_FILE=${SESSION_FILE:-/tmp/mm-session.jwt}
WORK=$(mktemp -d)
PROJECT_ID=''
FAILURES=0

# From a trap, so a failure halfway through still archives the project. Without this, a probe
# that breaks after provisioning leaves one in production and the next run diagnoses its own
# litter — which is exactly what the first run of this script did.
cleanup() {
  local archived
  if [ -n "${PROJECT_ID}" ]; then
    # Archived, not deleted. There is no DELETE route — projects carry an `archived` flag and
    # `GET /projects` returns them either way, which is a deliberate choice about a catalogue
    # somebody may still need to read.
    printf '\n%-52s' 'cleanup: archiving the probe project'
    archived=$(curl -sS -o "${WORK}/arch" -w '%{http_code}' -m 20 -X PATCH \
      -K "${WORK}/auth.conf" -H 'Content-Type: application/json' \
      -d '{"archived":true}' "${ORIGIN}/api/projects/${PROJECT_ID}")
    echo "${archived}"
    # Checked, not merely printed. A cleanup that fails quietly leaves a project active in
    # production and reports it only in a status code nobody was reading.
    case "${archived}" in
      2*) ;;
      *)
        echo "  FAILED to archive ${PROJECT_ID} — it is still active in production." >&2
        echo "  By hand: PATCH ${ORIGIN}/api/projects/${PROJECT_ID} {\"archived\":true}" >&2
        ;;
    esac
  fi
  rm -rf "${WORK}"
}
trap cleanup EXIT

# Body to a file, status to stdout, credentials from `-K`. Every call reports the same way so a
# reader compares like with like, and none of them names the token.
call() {
  local method=$1 url=$2 out=$3
  shift 3
  curl -sS -o "${out}" -w '%{http_code}' -m 20 -X "${method}" -K "${WORK}/auth.conf" "$@" "${url}"
}

say() { printf '%-52s' "$1"; }

# Reads one value out of a JSON body. The path is an expression over `r`, evaluated by node
# with the file named as an argument — the file, never the token.
field() {
  node -e "try{const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const v=$2;process.stdout.write(String(v??''))}catch{}" "$1" 2>/dev/null
}

fail() {
  FAILURES=$((FAILURES + 1))
  echo "  $1" >&2
}

if [ ! -s "${SESSION_FILE}" ]; then
  echo "No session token at ${SESSION_FILE}. See docs/replication.md." >&2
  exit 1
fi

echo "Probing ${ORIGIN}"
echo

# The session cookie goes into the config file for the same reason the access token will. `tr`
# reads the file rather than taking the token as an argument, and `printf` is a shell builtin,
# so the value never becomes another process's argv.
printf 'cookie = "mm_session=%s"\n' "$(tr -d '\n' < "${SESSION_FILE}")" > "${WORK}/auth.conf"

# 1. The session cookie has to cross the /api forwarder for this to work at all. A forwarder
#    that dropped Cookie would answer 401 here, and the sign-in design would be broken in a way
#    no unauthenticated probe can see — the redirect out to Google works either way.
say 'POST /api/auth/token (cookie crosses /api)'
status=$(call POST "${ORIGIN}/api/auth/token" "${WORK}/token")
echo "${status}"
[ "${status}" = "200" ] || {
  echo "  could not get an access token; stopping" >&2
  exit 1
}

# Written by node straight from the response body, replacing the cookie: the access token is
# never a shell variable and never an argument.
node -e "
const fs = require('fs')
const token = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')).accessToken
fs.writeFileSync(process.argv[2], 'header = \"Authorization: Bearer ' + token + '\"\n', { mode: 0o600 })
" "${WORK}/token" "${WORK}/auth.conf"

say '  token purpose / subject'
field "${WORK}/token" "(()=>{const p=JSON.parse(Buffer.from(r.accessToken.split('.')[1],'base64url'));return p.purpose+' / '+p.sub})()"
echo

# 2. The positive case CouchDB has never been shown: a signature that verifies.
say 'GET /db/ with a signed token'
status=$(call GET "${ORIGIN}/db/" "${WORK}/root")
echo "${status}"
[ "${status}" = "200" ] || fail "expected 200 from /db/ with a valid token"

say 'GET /db/_session (who CouchDB thinks we are)'
status=$(call GET "${ORIGIN}/db/_session" "${WORK}/sess")
echo "${status} $(field "${WORK}/sess" 'r.userCtx && r.userCtx.name')"

# 3. A project, because the browser never creates a database itself: the API provisions it with
#    admin credentials and writes a `_security` document naming the user. Replicating into a
#    database the token is not named in is the failure this step would otherwise miss.
say 'POST /api/projects (provisions a database)'
status=$(call POST "${ORIGIN}/api/projects" "${WORK}/project" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Replication probe — safe to archive"}')
echo "${status}"
case "${status}" in
  20*) ;;
  *)
    echo "  $(cat "${WORK}/project")" >&2
    exit 1
    ;;
esac

PROJECT_ID=$(field "${WORK}/project" 'r.projectId')
DB=$(field "${WORK}/project" 'r.dbName')
say '  database'
echo "${DB}"

# 4. The round trip PouchDB actually performs, and the reason this script has an exit status.
#    `type` is required by `infra/couchdb/design-docs/access.js`, which also checks the caller
#    against the `_security` writers — so a 403 here means the validator is enforcing and the
#    write did not land, which is how the first run of this script accidentally proved the
#    design document was deployed.
say 'PUT /db/<db>/probe-doc'
status=$(call PUT "${ORIGIN}/db/${DB}/probe-doc" "${WORK}/put" \
  -H 'Content-Type: application/json' \
  -d '{"type":"probe","note":"written through the Pages Function"}')
echo "${status} $(field "${WORK}/put" 'r.reason || r.error || (r.ok && "ok")')"
case "${status}" in
  20*) ;;
  *) fail "the write did not land, so there is no round trip to confirm" ;;
esac

say 'GET /db/<db>/probe-doc (round trip)'
status=$(call GET "${ORIGIN}/db/${DB}/probe-doc" "${WORK}/got")
note=$(field "${WORK}/got" 'r.note')
echo "${status} ${note}"
[ "${status}" = "200" ] || fail "the document did not read back"
[ "${note}" = "written through the Pages Function" ] ||
  fail "something read back, but not the document that was written"

say 'GET /db/<db>/_changes?since=0 (query string)'
status=$(call GET "${ORIGIN}/db/${DB}/_changes?since=0&limit=10" "${WORK}/changes")
echo "${status} $(field "${WORK}/changes" 'r.results && r.results.length + " change(s)"')"
[ "${status}" = "200" ] || fail "_changes did not answer; a mangled query string looks like this"

# `_bulk_docs` answers 201 for the request, not for each document in it, so the per-document
# results are what say whether the write happened.
say 'POST /db/<db>/_bulk_docs (what sync writes)'
status=$(call POST "${ORIGIN}/db/${DB}/_bulk_docs" "${WORK}/bulk" \
  -H 'Content-Type: application/json' \
  -d '{"docs":[{"_id":"probe-bulk","type":"probe"}]}')
echo "${status} $(field "${WORK}/bulk" 'Array.isArray(r) && r.map(d=>d.ok?"ok":(d.error||"?")).join(", ")')"
[ "$(field "${WORK}/bulk" 'Array.isArray(r) && r.every(d=>d.ok)')" = "true" ] ||
  fail "_bulk_docs accepted the request but refused a document"

# 5. The blocklist has to survive the new path. `/db` reaches CouchDB through the same host
#    Caddy as `couch.matter-manager.io`, and inheriting that `@forbidden` list rather than
#    keeping a second copy was the access-control decision the whole design rests on.
echo
for path in _all_dbs _utils/ _membership _cluster_setup; do
  say "GET /db/${path} (Caddy blocklist)"
  status=$(call GET "${ORIGIN}/db/${path}" "${WORK}/blocked")
  echo "${status}"
  [ "${status}" = "404" ] || fail "${path} is reachable through /db; the blocklist has a hole"
done

echo
if [ "${FAILURES}" -eq 0 ]; then
  echo "Replication works end to end: a document written through /db read back unchanged."
  exit 0
fi
echo "${FAILURES} check(s) failed. Replication is NOT confirmed." >&2
exit 1
