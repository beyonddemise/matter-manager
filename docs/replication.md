# Replication, and how to know it works

The browser replicates a project's PouchDB database against CouchDB. Nothing about that is
novel; what is worth writing down is the path a request takes and, more to the point, **which
parts of it have actually been observed working** rather than inferred from code that compiles.

## The path

```
browser  ──/db/<dbName>──▶  Cloudflare Pages Function  ──▶  Caddy (wisselroot)  ──▶  CouchDB
           Authorization:        frontend/functions/db/        couch.matter-manager.io
           Bearer <access>       [[path]].ts
```

Four things happen along it, and each is somebody's job:

- **`app-shell.ts`** builds `projectSync()` and starts one replication per project the signed-in
  user has. It is wired — `check:graph` will tell you so, and the built bundle carries
  `couchUrl:"/db"`.
- **The Pages Function** strips `/db` and forwards to `COUCHDB_URL`, carrying `Authorization`
  and deliberately *not* carrying `Cookie` (see the design note below).
- **Caddy** applies the `@forbidden` blocklist. `/db` reaches CouchDB through the same host
  Caddy that serves `couch.matter-manager.io`, so it inherits that list rather than keeping a
  second copy that could drift.
- **CouchDB** verifies the JWT against `[jwt_keys]`, then `infra/couchdb/design-docs/access.js`
  decides whether this user may write this document.

## The credential, and why there are two

The browser never holds CouchDB credentials. It holds an `mm_session` cookie, and exchanges it
at `POST /api/auth/token` for a one-hour access token whose public half **is** installed in
CouchDB's `[jwt_keys]`. The session cookie is signed with a different key that CouchDB cannot
verify at all — so a stolen session is not a database credential, which is the whole point of
`JWT_SESSION_PRIVATE_KEY` existing separately from `JWT_PRIVATE_KEY`.

That is also why the `/db` forwarder strips `Cookie`. The session cookie is `Path=/`, so the
browser attaches it to every `/db/*` request without being asked; CouchDB has no use for it, and
forwarding it would put a thirty-day credential into a second service's logs on every
replication request, with nothing anywhere looking wrong.

## What has been observed, and what has not

Measured against `https://app.matter-manager.io` on 2026-09-29. Reproduce with
`scripts/probe-replication.sh`.

### Without any credential

These need nothing but `curl`, and they establish more than they look like they do.

| Request to `/db/` | Response |
| --- | --- |
| no `Authorization` | `401 {"reason":"Authentication required."}` |
| `Bearer not.a.jwt` | `400 {"reason":"Malformed token"}` |
| well-formed JWT, `kid: ec-2026-09`, wrong signature | `400 {"reason":"Bad signature"}` |
| same, `kid: ec-does-not-exist` | `400 {"reason":"Unknown kid"}` |

The first says `require_valid_user` is in force. The second says **the forwarder carries
`Authorization`** — a header that never arrived would have produced the same "Authentication
required" as sending none, and nothing else distinguishes those two cases from outside.

The last pair is the one worth keeping. *Bad signature* and *Unknown kid* are different
answers: the first means CouchDB **found the key and did the crypto**, the second that it had no
such key. So `ec:$JWT_KEY_ID` is not merely present in `[jwt_keys]` but parseable as an EC
public key — which is exactly what `publicKeyForCouch` got wrong before `0b3cc88`, when it
emitted bare base64 DER instead of a PEM with `\n` escapes and the API crash-looped on startup.

### With a signed token

| Step | Result |
| --- | --- |
| `POST /api/auth/token` with the session cookie | `200`, `{accessToken, expiresIn: 3600}` |
| `GET /db/` with that token | `200` |
| `GET /db/_session` | `200` |
| `POST /api/projects` | `201`, database `project_<uuid>` |
| `GET /db/<db>/_changes?since=0&limit=10` | `200` |
| `POST /db/<db>/_bulk_docs` | `201` |
| `GET /db/_all_dbs`, `_utils/`, `_membership`, `_cluster_setup` | `404` |

The first line is the one that cannot be checked any other way: **the `/api` forwarder carries
`Cookie`.** If it dropped the header this would be a 401, and the sign-in design would be broken
invisibly — the redirect *out* to Google works either way, so a manual test that stops at the
consent screen proves nothing about it.

`_changes` is asked for with `limit=1&include_docs=true`, and both parameters are asserted
rather than the status alone. That is the difference between a check and a decoration: a
forwarder that dropped the query string entirely would still answer 200, and on a small database
with the same content — so the obvious version of this test could not fail for the reason its
own name gave. Making the *count* depend on `limit` and the *shape* of each result depend on
`include_docs` is what ties the assertion to the thing it claims to detect.

### Not yet observed

**A document written and read back.** The probe's first run sent `{"kind":"probe"}` and was
refused with `403 Every document must carry a 'type' field` — which is
`infra/couchdb/design-docs/access.js:59`, so that run proved the **validator** is deployed and
enforcing, and proved nothing about a successful write. The same function checks the caller
against the `_security` writers the API wrote at provisioning time, so both halves of the
access model are live.

The corrected probe sends a document carrying `type`, and **its exit status now depends on the
answer**: it fails unless the document read back is the document written. The first version
printed every result and exited 0 regardless, so a run that wrote nothing and read nothing still
looked like a pass — a probe that cannot fail measures nothing, which is the same defect as the
deploy check in L39, one layer out.

Until somebody runs it, "a document survives the round trip" is inference, not measurement —
which is the distinction this whole file exists to keep.

## Running the probe

It needs a session token, and the signing keys have never left the droplet. Mint one there,
for a throwaway subject, with the API's own `mintToken`:

```bash
# Before the redirect, not after. The shell creates the file, so its mode comes from the umask
# in force at that moment - a default 022 makes a live credential world-readable, and chmod
# afterwards closes a door that was already open.
umask 077

ssh wisselroot 'docker exec -i matter-manager-api node --input-type=module' \
  > /tmp/mm-session.jwt <<'JS'
import { signingKeyFromPem, mintToken } from '/app/dist/src/auth/jwt.js'
const now = Math.floor(Date.now() / 1000)
const key = signingKeyFromPem(process.env.JWT_KEY_ID + '-session', process.env.JWT_SESSION_PRIVATE_KEY)
console.log(mintToken(key, { purpose: 'session', sub: 'replication-probe', exp: now + 1800, iat: now }))
JS

bash scripts/probe-replication.sh
rm -f /tmp/mm-session.jwt
```

The token is a real thirty-minute credential for a synthetic user. Delete it afterwards; the
script never prints it, never puts it in a process argument, and neither should anything else —
`ps` is readable by other local users on most systems, so a token in a `curl -H` is a token
published to everyone logged in. The script writes it into a curl configuration file inside a
private temporary directory instead, and passes it with `-K`.

**The probe writes to production and cannot fully clean up.** It creates a project, and the API
has no `DELETE` for one — only `PATCH {"archived": true}` — so each run leaves an archived
project and its database behind. That is the API's design rather than an oversight in the
script, but it means the probe is not free and the leftovers are worth removing by hand
occasionally, with admin credentials, on the droplet.
