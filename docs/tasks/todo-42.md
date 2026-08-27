# Todo — #42 · M4-4 Mint CouchDB-validatable JWTs

Branch: `42-couchdb-jwt` (stacked on `39-openapi-drift`)

**Taken before #41 deliberately.** Sign-in's first scenario ends "signed in with an
application-issued JWT" — so minting is what sign-in returns, not the other way round. Same
reasoning as #40 coming before #38: the issue numbers are not always the dependency order.

## Acceptance criteria (from the issue)

```gherkin
Scenario: a token authenticates directly against CouchDB
Scenario: an expired token is refreshed transparently
Scenario: a token for one user cannot open another's database
Scenario: the key is confirmed in effect before serving traffic
Scenario: rotation does not interrupt anyone
```

## Review

**This PR covers the minting, verification and key-installation halves.** The refresh-on-401
scenario belongs to the browser's replication and lands with M5's sync work; the cross-user
denial is CouchDB's `_security` and is already verified in CI by
`infra/couchdb/verify-access-model.sh`.

### Nothing here is invented

`infra/couchdb/verify-jwt-model.sh` established the wire format against a real CouchDB 3.5.2 at
M0, including that expired tokens, tokens signed with another key, and tokens whose payload was
edited to claim a different `sub` are all genuinely refused. This module produces exactly what
that script proved is accepted, and makes the same three refusals itself so that a token which
would fail at CouchDB fails here first, with a reason.

### The one line that fails silently

```js
signer.sign({ key, dsaEncoding: 'ieee-p1363' })
```

Without it, Node signs correctly and encodes the signature as **DER** — the same algorithm,
different bytes, rejected by CouchDB with no hint as to why. The test pins the observable
difference rather than the flag: a P-256 R‖S signature is exactly 64 bytes and a DER one is
variable and starts with `0x30`. The mutation probe confirms removing the flag fails 8 tests.

### `node:crypto`, no `jose`

Both lines that usually motivate the dependency are one call each — `dsaEncoding` above, and
`createPublicKey({ key: jwk, format: 'jwk' })` for Google's JWKS when #41 needs it.

### Decisions with a failure mode behind each

**The algorithm is checked before the signature.** Not an ordering preference: accepting
whatever algorithm a token names is the classic JWT vulnerability, in both forms — `alg: none`,
and an HMAC token verified against the public key as though it were a shared secret. By the time
a signature has been checked, the algorithm has already been chosen.

**`verify` is wrapped in a `try`.** It does not merely return false for a signature of the wrong
shape — an empty one makes it *throw*. A test caught this: without the wrapper a malformed token
produces a crypto stack trace where a rejection was meant.

**`exp` is exclusive.** A token expiring exactly now has expired. Accepting it means accepting
one CouchDB may already be refusing, which presents as replication failing moments after a
successful refresh.

**`_couchdb.roles`, not `roles`.** CouchDB namespaces its own claims. A token carrying `roles`
succeeds as a user with *no* roles — which looks like a permissions bug rather than a claim-name
bug.

**The public key is stripped of its PEM banner and newlines.** CouchDB's config is an ini file
where a value cannot span lines: a full PEM is accepted into the config and then cannot be
parsed, so every token is refused while the configuration looks perfectly correct. A test
reassembles the stripped value into a PEM and verifies a real token with it.

### Startup refuses rather than hopes

`installSigningKey` writes the key and then **mints a token and asks CouchDB to accept it**. It
cannot be a fire-and-forget `PUT` for the reason above — the write succeeds for a value CouchDB
cannot use.

A `401` means the key did not take, and the service refuses to start with a message naming what
to check. A `403` is treated as **success**: the token was accepted and the probe user simply has
rights to nothing, which is authorisation rather than authentication — failing on it would mean
refusing to start for the very outcome that proves the key works.

`[chttpd] authentication_handlers` is deliberately **not touched**. It is read only at startup;
setting it at runtime returns 200, does nothing, and leaves every request authenticating as
anonymous rather than failing. Production bakes it into the image.

### Probe: 9/9

Including the DER encoding, the missing algorithm check, the inclusive expiry boundary, an
omitted `kid`, and the PEM banner. Two mutations first reported INCONCLUSIVE rather than
survived — my patterns did not match the source — which is the distinction the probe script
exists to make.
