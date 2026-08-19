# @matter-manager/api

The Fastify backend. Deliberately thin.

**Created in M4.**

## What belongs here

- Google OIDC (authorization code + PKCE) and JWT minting
- Project provisioning: create `project_<uuid>`, write `_security`, install `_design/access`
- Membership changes, invitations, ownership transfer
- Injecting the JWT public key into CouchDB at startup via
  `PUT /_node/_local/_config/jwt_keys/rsa:_default`
- Admin and audit endpoints (M7), billing webhooks (M8)

## What does not

Anything sync-related. Replication goes **browser → CouchDB directly**, authenticated by a
JWT that CouchDB validates itself using the public key. Proxying replication through this
service would put it on the critical path of every document, for no benefit.

## The OpenAPI contract

`openapi/matter-manager.yaml` is the source of truth, not a generated afterthought. It
exists so the backend could be reimplemented in Quarkus without touching the frontend
(ADR 0004). A CI check that fails when handlers drift from the contract is what keeps that
option real — without it, "we kept it open" quietly becomes false.
