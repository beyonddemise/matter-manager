# 16. Rate limiting is in-process, which constrains how the API is deployed

Date: 2026-08-27

## Status

Accepted. Implements the rate-limiting half of M4-8 (#47) and records the deployment constraint
it creates, which is the part that would otherwise be discovered rather than decided.

## Context

M4-8 asks for rate limits on the auth endpoints. The endpoints in question are sign-in, the
OAuth callback, the token exchange and sign-out — the ones reachable without a session, where
the cost of an attempt is highest (each sign-in may reach Google) and where guessing is the
attack.

Two questions had to be answered together, because the answer to one decides the other:

1. **Where does the count live?** In this process, or in something shared?
2. **What does a limit mean when the service is scaled out?**

A shared store — Redis, or CouchDB itself — makes a limit mean the same thing however many
instances are running. It also introduces a dependency that nothing else in this service needs,
that has to be available for sign-in to work at all, and that becomes a second thing to operate.
For an application whose entire storage story is "CouchDB, replicated to the browser", adding a
cache server to count sign-in attempts is a large change to the shape of the deployment.

An in-process count needs nothing. Its cost is that *n* instances enforce the limit *n* times
over: a limit of 20 becomes an effective limit of 20 × instances for an attacker who reaches
them all, because a load balancer will spread the attempts.

## Decision

**Count in memory, in each process, and deploy the API as a single instance** until there is a
reason not to.

The limits are per client address and per endpoint, in a fixed window
(`packages/api/src/security/rate-limit.ts`). Sign-in gets a small budget; the token exchange
gets a larger one, because a page refreshes its access token for as long as it stays open.

Two consequences are written down here rather than left in the code:

- **Horizontal scaling weakens the limit** in exact proportion to the number of instances. It
  does not break anything else — the limits are the only per-process state the API has — so
  scaling out is a decision about how much the limit is worth, not a migration.
- **The API must be behind a proxy that sets `X-Forwarded-For`, and `TRUST_PROXY=true` must be
  set for that deployment.** Without it every request appears to come from the proxy, one
  address is counted for everybody, and the first twenty sign-in attempts from anywhere lock out
  the world. With it set where there is *no* trusted proxy, any client can claim any address and
  the limit is off. There is no safe default that covers both, so the default trusts nothing and
  the deployment says.

## Consequences

**What this protects against:** credential stuffing and brute force against sign-in from a
small number of addresses, and a runaway client refreshing tokens in a loop.

**What it does not:** a distributed flood from many addresses. That is a volumetric problem, it
is answered at the edge rather than in the application, and the memory ceiling
(`maxClients`) exists to make sure the attempt costs this process a bounded amount rather than
to make it fail elegantly. When the ceiling is reached, a **new** client is refused rather than
admitted by evicting an existing one — eviction would be a bypass anybody could trigger on
purpose, and these are sign-in endpoints, where refusing is the conservative answer.

**When to revisit:** the moment a second API instance is run. At that point the choice is
between a shared store and accepting a limit that means *n* times what it says, and this record
exists so that it is a choice rather than a surprise.

**No dependency was added.** `@fastify/rate-limit` is a good library; what it would have
provided here is a `Map`, an integer and a subtraction, which is the test ADR 0013 sets.
