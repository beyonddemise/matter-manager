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
#   Expects /tmp/mm-handoff.jwt (or $HANDOFF_FILE) to hold a handoff token minted on the
#   droplet — the credential the sign-in callback would have set as the `mm_handoff` cookie. The
#   mint command is in `docs/replication.md`, and it sets `umask 077` first — a plain redirect
#   would create a live credential with whatever the caller's umask allows, which on a default
#   022 is world-readable.
#
#   The flow is phase A's: the handoff goes to `POST /api/auth/token` as a cookie, exactly as
#   the browser sends it after sign-in, and the answer carries an access token and a refresh
#   token in its body. The access token is used for everything after; the refresh token is kept
#   only so the cleanup can sign out with it, which revokes it on the server. A handoff is single
#   use, so each run needs a freshly minted one.
#
#   Not yet run against production since phase A replaced the session cookie: the steps below
#   are written to the new flow and checked by `bash -n`, not by a live run.
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
HANDOFF_FILE=${HANDOFF_FILE:-/tmp/mm-handoff.jwt}
WORK=$(mktemp -d)
PROJECT_ID=''
FAILURES=0

# From a trap, so a failure halfway through still archives the project. Without this, a probe
# that breaks after provisioning leaves one in production and the next run diagnoses its own
# litter — which is exactly what the first run of this script did.
cleanup() {
  local archived signed_out
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
  # Signed out last, because archiving needs the access token this denies. The refresh token is
  # a thirty-day credential; leaving it live because the probe had finished would be a probe
  # that leaks one per run. The body comes from a file node wrote, never from an argument.
  if [ -s "${WORK}/signout.json" ]; then
    printf '%-52s' 'cleanup: signing out (revokes the refresh token)'
    signed_out=$(curl -sS -o /dev/null -w '%{http_code}' -m 20 -X POST \
      -K "${WORK}/auth.conf" -H 'Content-Type: application/json' \
      --data-binary "@${WORK}/signout.json" "${ORIGIN}/api/auth/signout")
    echo "${signed_out}"
    [ "${signed_out}" = "204" ] ||
      echo "  FAILED to sign out; the probe's refresh token may still be live until it expires." >&2
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

if [ ! -s "${HANDOFF_FILE}" ]; then
  echo "No handoff token at ${HANDOFF_FILE}. See docs/replication.md." >&2
  exit 1
fi

echo "Probing ${ORIGIN}"
echo

# The handoff cookie goes into the config file for the same reason the access token will. `tr`
# reads the file rather than taking the token as an argument, and `printf` is a shell builtin,
# so the value never becomes another process's argv.
printf 'cookie = "mm_handoff=%s"\n' "$(tr -d '\n' < "${HANDOFF_FILE}")" > "${WORK}/auth.conf"

# 1. The handoff cookie has to cross the /api forwarder for this to work at all. A forwarder
#    that dropped Cookie would answer 401 here, and the sign-in design would be broken in a way
#    no unauthenticated probe can see — the redirect out to Google works either way.
say 'POST /api/auth/token (handoff cookie crosses /api)'
status=$(call POST "${ORIGIN}/api/auth/token" "${WORK}/token")
echo "${status}"
[ "${status}" = "200" ] || {
  echo "  could not get an access token; stopping" >&2
  exit 1
}

# Written by node straight from the response body, replacing the cookie: neither token is ever a
# shell variable or an argument. The refresh token goes only into the sign-out body the cleanup
# sends; nothing else in the probe refreshes.
node -e "
const fs = require('fs')
const body = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'))
fs.writeFileSync(process.argv[2], 'header = \"Authorization: Bearer ' + body.accessToken + '\"\n', { mode: 0o600 })
fs.writeFileSync(process.argv[3], JSON.stringify({ refreshToken: body.refreshToken }), { mode: 0o600 })
" "${WORK}/token" "${WORK}/auth.conf" "${WORK}/signout.json"

say '  token purpose / subject'
field "${WORK}/token" "(()=>{const p=JSON.parse(Buffer.from(r.accessToken.split('.')[1],'base64url'));return p.purpose+' / '+p.sub})()"
echo

# 2. The positive case CouchDB has never been shown: a signature that verifies.
say 'GET /db/ with a signed token'
status=$(call GET "${ORIGIN}/db/" "${WORK}/root")
echo "${status}"
[ "${status}" = "200" ] || fail "expected 200 from /db/ with a valid token"

# Asserted, not just printed: `docs/replication.md` lists a successful `_session` among the
# results this script reproduces, and a line that is reported but never checked is a line the
# document is wrong about the moment it stops holding. The name is compared against the token's
# own `sub`, which is the claim CouchDB maps to a user - equal names prove the mapping, where a
# bare 200 would only prove the request arrived.
say 'GET /db/_session (CouchDB maps sub to a user)'
status=$(call GET "${ORIGIN}/db/_session" "${WORK}/sess")
name=$(field "${WORK}/sess" 'r.userCtx && r.userCtx.name')
subject=$(field "${WORK}/token" "JSON.parse(Buffer.from(r.accessToken.split('.')[1],'base64url')).sub")
echo "${status} ${name}"
[ "${status}" = "200" ] || fail "_session did not answer"
[ -n "${name}" ] && [ "${name}" = "${subject}" ] ||
  fail "CouchDB sees '${name}', the token says '${subject}'"

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
# Checked before anything else uses them. An empty `projectId` leaves the EXIT trap with nothing
# to archive, so a response that provisioned a database but did not name it would strand that
# database in production and say nothing - the same outcome as the missing DELETE route, arrived
# at from the other direction.
if [ -z "${PROJECT_ID}" ] || [ -z "${DB}" ]; then
  echo "  The project response named no projectId or dbName, so the cleanup cannot run." >&2
  echo "  A database may have been provisioned. The response was:" >&2
  cat "${WORK}/project" >&2
  exit 1
fi
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

# `_bulk_docs` answers 201 for the request, not for each document in it, so the per-document
# results are what say whether the write happened. `every()` alone is not enough either: it is
# true of an empty array, so a response confirming that nothing was written would have passed.
say 'POST /db/<db>/_bulk_docs (what sync writes)'
status=$(call POST "${ORIGIN}/db/${DB}/_bulk_docs" "${WORK}/bulk" \
  -H 'Content-Type: application/json' \
  -d '{"docs":[{"_id":"probe-bulk","type":"probe"}]}')
echo "${status} $(field "${WORK}/bulk" 'Array.isArray(r) && r.map(d=>d.ok?"ok":(d.error||"?")).join(", ")')"
case "${status}" in
  20*) ;;
  *) fail "_bulk_docs was refused" ;;
esac
[ "$(field "${WORK}/bulk" 'Array.isArray(r) && r.length === 1 && r[0].ok === true && r[0].id === "probe-bulk"')" = "true" ] ||
  fail "_bulk_docs did not report one accepted document called probe-bulk"

# Last, and deliberately so: it needs two documents in the database to mean anything.
#
# **The assertion has to depend on the query string, or it is decorative.** The earlier version
# asked for `?since=0&limit=10` and checked only the status - but a forwarder that dropped the
# query entirely would still answer 200, and on a database this small with the same content, so
# the check could not fail for the reason its own name gave. That is the defect L39 is about,
# one layer out.
#
# `limit=1` against a database now holding probe-doc, probe-bulk and the design document makes
# the *count* depend on the parameter surviving, and `include_docs=true` makes the *shape* of
# each result depend on it too. Drop either and this fails.
say 'GET /db/<db>/_changes?limit=1&include_docs (query survives)'
status=$(call GET "${ORIGIN}/db/${DB}/_changes?since=0&limit=1&include_docs=true" "${WORK}/changes")
echo "${status} $(field "${WORK}/changes" 'r.results && r.results.length + " result(s)"')"
[ "${status}" = "200" ] || fail "_changes did not answer"
[ "$(field "${WORK}/changes" 'r.results && r.results.length === 1')" = "true" ] ||
  fail "limit=1 did not limit the result; the query string is not reaching CouchDB"
[ "$(field "${WORK}/changes" 'r.results && r.results[0] && r.results[0].doc !== undefined')" = "true" ] ||
  fail "include_docs=true returned no document; the query string is not reaching CouchDB"

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
