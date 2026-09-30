# Plans and capacity — implementation plan (phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the plan a project capacity that is actually enforced, stored per user, and settable only by an operator.

**Architecture:** `backend/src/domain/can.ts` grows two plan tiers, a limit table with a `-1` sentinel, and a single `withinLimit` that is the only place the sentinel is interpreted. `POST /projects` counts what the caller owns and hands that to the policy on the `Principal`. A `plan` field joins `locale` on the `_users` document; `PATCH /profile` accepts it only from a role-holder, and `PUT /customer` is the operator route for somebody else's account.

**Tech Stack:** TypeScript (NodeNext, `verbatimModuleSyntax`), Fastify, Vitest, Biome, CouchDB `_users`.

**Spec:** `docs/superpowers/specs/2026-10-01-projects-page-and-plans-design.md`

**This is phase 1 of two.** Nothing here is visible in the interface. Phase 2 — the projects landing page, slots, location and manual sync — gets its own plan once this lands, because its design depends on the API shape this produces rather than on a prediction of it.

## Global Constraints

- **Node >= 24.** Both `package.json` files declare it.
- **Every relative import specifier ends in `.js`** (`module: NodeNext`, `verbatimModuleSyntax: true`). Type-only imports use `import type`.
- **Biome**: single quotes, no semicolons, trailing commas, 2-space indent, 100-column lines. `npm run check:fix` in `backend/`.
- **No new dependency.** `dependency-policy.json` is enforced by `npm run check:deps`, and `backend` is not in `BUNDLED_PACKAGES`, so only its shipping fields are checked — but ADR 0013 still applies.
- **ADR 0009 holds throughout: no `plan === 'free'` anywhere outside the policy table.** Handlers ask `can()`; clients read the limit the API reports. This is the rule the whole file exists to enforce, and the plan's job is to add tiers without adding a conditional.
- **`openapi.yaml` at the repository root is the contract of record.** `backend/test/openapi-drift.test.ts` walks every operation and validates real responses against it, so a new response field that the contract does not describe fails there.
- **Comment style**: this repository explains *why* at length and names the failure a line prevents. Match `can.ts` and `store.ts`, which are the two files most of this touches.
- **Commit trailer**: every commit ends with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## Review Focus

Five things the spec implies and no task's tests would otherwise exercise. Each has its test assigned to the task that owns the code.

1. **A plan string the code does not know.** `plan` is hand-edited into a CouchDB document by an operator, so `"Pro"`, `"premium"` or a typo will happen. `PROJECT_LIMITS[plan]` is then `undefined`, every comparison against it is `false`, and the effect is either a crash or an accidental grant. It must degrade to `free`. → Task 3.
2. **Archived projects and the count.** The spec does not say whether an archived project occupies a slot. Its database still exists and still costs, and `GET /projects` returns archived projects deliberately so they can be brought back — so they count. Stated here because an implementer would otherwise guess, and the two guesses differ. → Task 4.
3. **Two creations racing at the limit.** Both count `limit - 1`, both pass the gate, both create. The count is read before the gate and nothing holds a lock. → Task 4 pins the single-request behaviour and the plan states the accepted residual.
4. **A role that merely contains the word.** A user whose roles include `customerservices` or `Customerservice` must not pass the gate; membership is exact, not substring or case-insensitive. → Task 5.
5. **`PUT /customer` for a subject who has never signed in.** There is no `_users` document to update, and `store.update` throws a bare `Error` in that case today. It must be a 404, not a 500. → Task 6.

---

### Task 1: The limit table, and the sentinel that must be tested before it is compared

**Files:**
- Modify: `backend/src/domain/can.ts`
- Test: `backend/test/domain/can.test.ts`

**Interfaces:**
- Produces: `type Plan = 'free' | 'user' | 'pro'`, `PROJECT_LIMITS: Readonly<Record<Plan, number>>`, `withinLimit(owned: number, limit: number): boolean`.

- [ ] **Step 1: Write the failing test**

Append to `backend/test/domain/can.test.ts`:

```ts
describe('the project limit table', () => {
  it('gives each plan the capacity the product sells', () => {
    expect(PROJECT_LIMITS.free).toBe(1)
    expect(PROJECT_LIMITS.user).toBe(5)
  })

  it('says unlimited with -1 rather than with Infinity or an absence', () => {
    // Infinity compares correctly and then serialises to null, so an API computing with it
    // would report something it did not mean. `undefined` makes every reader handle two
    // shapes. -1 is one number that survives JSON.
    expect(PROJECT_LIMITS.pro).toBe(-1)
  })

  it('allows a project below the limit and refuses one at it', () => {
    expect(withinLimit(0, 1)).toBe(true)
    expect(withinLimit(1, 1)).toBe(false)
    expect(withinLimit(4, 5)).toBe(true)
    expect(withinLimit(5, 5)).toBe(false)
  })

  it('allows every count when the limit is the -1 sentinel', () => {
    // The failure this pins is silent and exactly backwards: `owned >= limit` is true for
    // every count when limit is -1, including zero, so the plan with no limit would be the
    // only one that could never create a project.
    expect(withinLimit(0, PROJECT_LIMITS.pro)).toBe(true)
    expect(withinLimit(1, PROJECT_LIMITS.pro)).toBe(true)
    expect(withinLimit(9999, PROJECT_LIMITS.pro)).toBe(true)
  })

  it('refuses everything when the limit is zero', () => {
    // Not a plan today, and the table is a place somebody will one day write a suspended
    // account. Zero has to mean none rather than falling into the sentinel branch.
    expect(withinLimit(0, 0)).toBe(false)
  })
})
```

Add `PROJECT_LIMITS` and `withinLimit` to the existing import from `../../src/domain/index.js`.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd backend && npx vitest run test/domain/can.test.ts
```

Expected: FAIL — `PROJECT_LIMITS` is not exported.

- [ ] **Step 3: Write the implementation**

In `backend/src/domain/can.ts`, replace the `Plan` declaration:

```ts
/**
 * Subscription tiers.
 *
 * `free` was the only one until capacity became real. The others are named for what they are
 * to a person rather than for what they cost, so a price change is not a type change.
 */
export type Plan = 'free' | 'user' | 'pro'
```

and add, directly beneath it:

```ts
/**
 * How many projects each plan may own.
 *
 * A table rather than a conditional, for the reason the policy table below is a table: ADR 0009
 * forbids `plan === 'free'` anywhere, and a lookup cannot drift from the type the way a chain of
 * `if` can.
 */
export const PROJECT_LIMITS: Readonly<Record<Plan, number>> = Object.freeze({
  free: 1,
  user: 5,
  /**
   * Unlimited, as a sentinel rather than as `Infinity` or an absence.
   *
   * `Infinity` compares correctly and then serialises to `null`, so an API that computed with
   * it would report something it did not mean. `undefined` forces every reader to handle two
   * shapes. `-1` is one number, it survives JSON, and it is what the contract describes.
   *
   * **It must be tested before it is compared, never after.** `owned >= limit` with a limit of
   * `-1` is true for every count including zero, so the plan with no limit would be the only
   * one that can never create a project — a failure that is both silent and exactly backwards.
   * Every read of this table goes through {@link withinLimit}, which is why that function
   * exists rather than the comparison being written out at each call site.
   */
  pro: -1,
} satisfies Record<Plan, number>)

/**
 * Whether one more project is allowed.
 *
 * The only place the `-1` sentinel is interpreted. Negative first, so unlimited never reaches
 * the comparison.
 */
export function withinLimit(owned: number, limit: number): boolean {
  return limit < 0 || owned < limit
}
```

- [ ] **Step 4: Export them and run the tests**

`backend/src/domain/index.ts` re-exports from `can.js`; add `PROJECT_LIMITS` and `withinLimit` to that export list beside `can`, `ACTIONS` and `POLICIES`.

```bash
cd backend && npx vitest run test/domain/can.test.ts && npm run typecheck
```

Expected: PASS. Typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/stw/Code/matter-manager && npm --prefix backend run check:fix
git add backend/src/domain/can.ts backend/src/domain/index.ts backend/test/domain/can.test.ts
git commit -m "$(cat <<'EOF'
feat(domain): plan tiers, and a limit table whose sentinel is tested not compared

-1 for unlimited rather than Infinity, which serialises to null, or undefined, which makes
every reader handle two shapes. The sentinel has to be tested before it is compared: `owned >=
limit` is true for every count when limit is -1, including zero, so `pro` would be the only
plan that could never create a project. `withinLimit` exists so that branch is written once.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The `project.create` policy, and the count the signature cannot carry

**Files:**
- Modify: `backend/src/domain/can.ts`
- Test: `backend/test/domain/can.test.ts`

**Interfaces:**
- Consumes: `PROJECT_LIMITS`, `withinLimit` (Task 1).
- Produces: `Principal` gains `readonly ownedProjects: number`; `POLICIES['project.create']` becomes a real policy.

- [ ] **Step 1: Write the failing test**

Append to `backend/test/domain/can.test.ts`:

```ts
describe('creating a project against a plan', () => {
  const principal = (plan: Plan, ownedProjects: number): Principal => ({
    sub: 'user-1',
    plan,
    ownedProjects,
  })

  it('lets a free account create its first project and refuse its second', () => {
    expect(can(principal('free', 0), 'project.create')).toBe(true)
    expect(can(principal('free', 1), 'project.create')).toBe(false)
  })

  it('lets a user account up to five', () => {
    expect(can(principal('user', 4), 'project.create')).toBe(true)
    expect(can(principal('user', 5), 'project.create')).toBe(false)
  })

  it('never refuses a pro account', () => {
    // The sentinel reaching the policy is the case that matters: a comparison written here
    // rather than in withinLimit would refuse every one of these.
    expect(can(principal('pro', 0), 'project.create')).toBe(true)
    expect(can(principal('pro', 500), 'project.create')).toBe(true)
  })

  it('still permits the actions no plan gates yet', () => {
    // The policy table is all-or-nothing to a careless edit: replacing ALLOW for one action is
    // an easy way to replace it for the neighbours too.
    expect(can(principal('free', 99), 'device.create')).toBe(true)
    expect(can(principal('free', 99), 'pdf.export')).toBe(true)
  })
})
```

Add `Plan`, `Principal` and `PROJECT_LIMITS` to the test file's imports as needed.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd backend && npx vitest run test/domain/can.test.ts
```

Expected: FAIL — a type error on `ownedProjects`, which `Principal` does not have.

- [ ] **Step 3: Write the implementation**

In `can.ts`, extend `Principal`:

```ts
/** Whoever is asking. */
export interface Principal {
  /** The OIDC subject, which is also the CouchDB user name. */
  readonly sub: string
  readonly plan: Plan
  /**
   * How many projects this subject owns.
   *
   * On the principal rather than passed to the policy, because `Policy` is
   * `(principal, project?) => boolean` and a creation has no project to inspect — the count is
   * a fact about the actor, which is what a principal is for. The cost is that the caller has
   * to read it: `POST /projects` counts before it may ask. That is one query on the one route
   * that needs it, against the alternative of a third argument threaded through every policy
   * and every call site.
   */
  readonly ownedProjects: number
}
```

and replace the `project.create` entry:

```ts
  'project.create': (principal) =>
    withinLimit(principal.ownedProjects, PROJECT_LIMITS[principal.plan]),
```

- [ ] **Step 4: Run the tests**

```bash
cd backend && npx vitest run test/domain/ && npm run typecheck
```

Expected: the new tests pass. **Typecheck will fail elsewhere** — `backend/src/projects/routes.ts` builds `{ sub, plan: 'free' }` and now lacks `ownedProjects`. That is Task 4's job; leave it failing and say so in the commit.

- [ ] **Step 5: Commit**

```bash
cd /Users/stw/Code/matter-manager && npm --prefix backend run check:fix
git add backend/src/domain/can.ts backend/test/domain/can.test.ts
git commit -m "$(cat <<'EOF'
feat(domain): project.create asks the plan's capacity

The policy signature cannot answer this on its own: `Policy` is `(principal, project?)` and a
creation has no project to inspect, so the owned count goes on the principal - a fact about the
actor, which is what a principal is for. The caller pays one query for it.

Typecheck is deliberately red until the route supplies the count; that is the next commit.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `plan` on the user document, and a plan string nobody wrote on purpose

**Files:**
- Modify: `backend/src/profile/store.ts`
- Test: `backend/test/profile/profile.test.ts`

**Interfaces:**
- Consumes: `Plan` (Task 1).
- Produces: `Profile` gains `readonly plan: Plan`; `ProfileStore` gains `rolesOf(sub: string): Promise<readonly string[]>` and `setPlan(sub: string, plan: Plan): Promise<Profile>`.

- [ ] **Step 1: Write the failing test**

Append to `backend/test/profile/profile.test.ts`, using that file's existing fake CouchDB helper:

```ts
describe('the plan on a user document', () => {
  it('reads free when the document has never been given one', async () => {
    // Nothing is migrated. A user who predates capacity, or whom no operator has touched,
    // reads correctly rather than reading undefined.
    const store = storeWith({ name: 'user-1', roles: [], type: 'user' })
    expect((await store.read('user-1'))?.plan).toBe('free')
  })

  it('reads the plan an operator wrote', async () => {
    const store = storeWith({ name: 'user-1', roles: [], type: 'user', plan: 'pro' })
    expect((await store.read('user-1'))?.plan).toBe('pro')
  })

  it('falls back to free for a plan string the code does not know', async () => {
    // `plan` is hand-edited into CouchDB by an operator, so "Pro", "premium" and typos will
    // happen. An unknown string must not become a lookup miss: PROJECT_LIMITS[plan] would be
    // undefined, every comparison against it false, and the account either crashes a request
    // or is silently granted something. Free is the safe reading of "I do not know".
    const store = storeWith({ name: 'user-1', roles: [], type: 'user', plan: 'Pro' })
    expect((await store.read('user-1'))?.plan).toBe('free')
  })

  it('reports the roles CouchDB holds', async () => {
    const store = storeWith({ name: 'user-1', roles: ['customerservice'], type: 'user' })
    expect(await store.rolesOf('user-1')).toEqual(['customerservice'])
  })

  it('reports no roles for a subject with no document', async () => {
    // The gate asks this before it knows whether the subject exists, and an absent user has no
    // roles rather than an error - the 404 belongs to the route, not to a role check.
    const store = storeWith()
    expect(await store.rolesOf('nobody')).toEqual([])
  })

  it('does not take roles or type from an ordinary update', async () => {
    // This is the property the whole role gate rests on: a user cannot grant themselves the
    // role that would let them set their plan. It is true today by construction - `update`
    // spreads the existing document and applies named fields - and this test is about the
    // tidying refactor that replaces those named fields with a spread of the request body.
    const store = storeWith({ name: 'user-1', roles: ['customerservice'], type: 'user' })
    await store.update('user-1', {
      locale: 'de',
      ...({ roles: ['_admin'], type: 'evil', plan: 'pro' } as object),
    })
    const stored = await store.read('user-1')
    expect(await store.rolesOf('user-1')).toEqual(['customerservice'])
    expect(stored?.plan).toBe('free')
  })

  it('sets a plan through the path meant for it', async () => {
    const store = storeWith({ name: 'user-1', roles: [], type: 'user' })
    expect((await store.setPlan('user-1', 'user')).plan).toBe('user')
    expect((await store.read('user-1'))?.plan).toBe('user')
  })
})
```

`storeWith(document?)` is a helper this task adds beside the file's existing fixtures: it builds a `profileStore` over the fake CouchDB seeded with zero or one `_users` document at `org.couchdb.user:<name>`.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd backend && npx vitest run test/profile/profile.test.ts
```

Expected: FAIL — `rolesOf` and `setPlan` are not on `ProfileStore`, and `Profile` has no `plan`.

- [ ] **Step 3: Write the implementation**

In `backend/src/profile/store.ts`:

```ts
import type { Plan } from '../domain/index.js'
```

Add `plan` to both shapes:

```ts
export interface Profile {
  readonly sub: string
  readonly email: string
  readonly displayName: string
  readonly locale: Locale
  /** What the account may do. Absent from the document means `free`; see {@link isPlan}. */
  readonly plan: Plan
}
```

```ts
interface UserDocument {
  // ...existing fields unchanged...
  readonly plan?: string
}
```

`plan` is typed `string` on the document and `Plan` on the profile, deliberately: the document is whatever an operator typed, and the narrowing happens in one place.

```ts
/** Whether a value is a plan this build knows. */
export function isPlan(value: unknown): value is Plan {
  return value === 'free' || value === 'user' || value === 'pro'
}
```

In `toProfile`, add:

```ts
    // Unknown reads as free, for the same reason an unknown locale reads as `auto`: this field
    // is hand-edited by an operator, so a typo is a question of when. A miss would make
    // PROJECT_LIMITS[plan] undefined and every comparison against it false, which is a crash
    // or a silent grant depending on where it lands.
    plan: isPlan(document.plan) ? document.plan : 'free',
```

Add to the `ProfileStore` interface and its implementation:

```ts
  /** The roles CouchDB holds for this subject, or none when there is no document. */
  rolesOf(sub: string): Promise<readonly string[]>
  /** Sets the plan. Separate from {@link update} because a user may not do this to themselves. */
  setPlan(sub: string, plan: Plan): Promise<Profile>
```

```ts
    async rolesOf(sub: string): Promise<readonly string[]> {
      return (await load(sub))?.roles ?? []
    },

    async setPlan(sub: string, plan: Plan): Promise<Profile> {
      const existing = await load(sub)
      if (existing === undefined) {
        throw new UnknownSubjectError(sub)
      }
      // Spread first, exactly as `update` does, so CouchDB's own fields survive. The difference
      // between this and `update` is not how it writes but who is allowed to call it.
      const document: UserDocument = { ...existing, plan }
      await couch.putDoc(USERS, document)
      return toProfile(document)
    },
```

and, above the store:

```ts
/** Raised when a subject has no `_users` document. The route turns this into a 404. */
export class UnknownSubjectError extends Error {
  constructor(readonly sub: string) {
    // `update` throws a bare Error for the same condition, which a route cannot tell from a
    // bug. This one is nameable, so "no such account" and "something went wrong" can be
    // different answers to an operator who needs to know which.
    super(`No profile for ${sub}`)
    this.name = 'UnknownSubjectError'
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
cd backend && npx vitest run test/profile/ && npm run typecheck
```

Expected: the profile tests pass. Typecheck still red from Task 2 until Task 4.

- [ ] **Step 5: Commit**

```bash
cd /Users/stw/Code/matter-manager && npm --prefix backend run check:fix
git add backend/src/profile/store.ts backend/test/profile/profile.test.ts
git commit -m "$(cat <<'EOF'
feat(profile): a plan on the user document, and roles the gate can read

`plan` is typed string on the document and Plan on the profile, because the document is whatever
an operator typed into CouchDB by hand. An unknown string reads as free: a lookup miss would
make PROJECT_LIMITS[plan] undefined and every comparison against it false, which is a crash or
a silent grant depending where it lands.

`rolesOf` is what the role gate reads. It answers no roles for a subject with no document,
because the gate asks before anything knows whether the subject exists.

The test that matters most is the one asserting an ordinary update cannot write roles, type or
plan. That is true today by construction - update spreads the existing document and applies
named fields - and the test is about the tidying refactor that replaces them with a spread of
the request body, which would make the role gate meaningless without failing anything else.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Counting what the caller owns, and refusing in a way the page can read

**Files:**
- Modify: `backend/src/projects/routes.ts:128-141`
- Test: `backend/test/projects/routes.test.ts`

**Interfaces:**
- Consumes: `Principal.ownedProjects` (Task 2), `Profile.plan` (Task 3), `projectsFor` from `registry.js`.
- Produces: `POST /projects` answers `403 {title, status: 403, reason: 'project-limit-reached'}` at capacity.

- [ ] **Step 1: Write the failing test**

Append to `backend/test/projects/routes.test.ts`:

```ts
describe('creating a project against the plan', () => {
  it('creates the first project on a free plan', async () => {
    const app = await serverWithProjects({ plan: 'free', owned: 0 })
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer('user-1') },
      payload: { name: 'Home' },
    })
    expect(response.statusCode).toBe(201)
  })

  it('refuses the second, and says why in a way a client can branch on', async () => {
    // An empty 403 leaves the page unable to tell "you have used all your slots" from "you may
    // not do this", and those deserve different sentences.
    const app = await serverWithProjects({ plan: 'free', owned: 1 })
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer('user-1') },
      payload: { name: 'Second' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ reason: 'project-limit-reached' })
  })

  it('counts an archived project against the limit', async () => {
    // Archiving is not deletion (#55) - the database still exists and still costs - so an
    // archived project occupies its slot. The alternative would let a free account accumulate
    // databases without limit by archiving each one.
    const app = await serverWithProjects({ plan: 'free', owned: 1, archived: true })
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer('user-1') },
      payload: { name: 'Second' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('does not count a project somebody else owns', async () => {
    // Membership is not ownership. A free user invited to a colleague's project keeps their
    // own slot, which is the point of counting ownership rather than visibility.
    const app = await serverWithProjects({ plan: 'free', owned: 0, memberOf: 3 })
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer('user-1') },
      payload: { name: 'Mine' },
    })
    expect(response.statusCode).toBe(201)
  })

  it('never refuses a pro account', async () => {
    const app = await serverWithProjects({ plan: 'pro', owned: 50 })
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer('user-1') },
      payload: { name: 'Another' },
    })
    expect(response.statusCode).toBe(201)
  })
})
```

`serverWithProjects({plan, owned, archived?, memberOf?})` is a helper this task adds beside the file's existing `buildServer` fixtures: it seeds the fake CouchDB registry with `owned` pointers whose participant role is `owner` (archived when asked) and `memberOf` pointers whose role is `member`, and a `_users` document carrying `plan`.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd backend && npx vitest run test/projects/routes.test.ts
```

Expected: FAIL — the handler does not read a plan and does not send `reason`.

- [ ] **Step 3: Write the implementation**

In `backend/src/projects/routes.ts`, replace the principal construction and the refusal inside `app.post('/projects', ...)`:

```ts
    // Read before the gate, because the gate cannot read. `role === 'owner'` rather than the
    // row's presence: a project somebody shared with this user is theirs to open and not theirs
    // to count, and archived ones count because archiving is not deletion (#55) - the database
    // still exists.
    const owned = (await projectsFor(deps.couch, sub)).filter((row) => row.role === 'owner').length
    const profile = await deps.profiles.read(sub)
    const principal: Principal = { sub, plan: profile?.plan ?? 'free', ownedProjects: owned }

    try {
      gate(principal, CREATE)
    } catch (error) {
      if (!(error instanceof NotEntitledError)) throw error
      // Named, not empty. `reply.code(403).send()` told the page nothing, so it could not tell
      // a capacity refusal from a permission one - and only one of those is fixed by upgrading.
      return reply.code(403).send({
        title: 'This plan has no room for another project.',
        status: 403,
        reason: 'project-limit-reached',
      })
    }
```

`deps.profiles` is a `ProfileStore`, added to this module's dependency interface and supplied in `composition.ts` from the store that already exists there.

- [ ] **Step 4: Run the tests**

```bash
cd backend && npx vitest run && npm run typecheck
```

Expected: PASS, and **typecheck is now clean** — this is the commit that closes what Task 2 opened.

- [ ] **Step 5: Commit**

```bash
cd /Users/stw/Code/matter-manager && npm --prefix backend run check:fix
git add backend/src/projects/routes.ts backend/src/composition.ts backend/test/projects/routes.test.ts
git commit -m "$(cat <<'EOF'
feat(projects): refuse creation past the plan's capacity, and say which refusal it is

The count is read before the gate because the gate cannot read. Ownership, not visibility: a
project shared with somebody is theirs to open and not theirs to count. Archived ones count,
because archiving is not deletion (#55) and the database still exists - otherwise a free
account accumulates databases without limit by archiving each one.

The refusal carries a reason. An empty 403 left the page unable to tell "you have used all your
slots" from "you may not do this", and only one of those is fixed by upgrading.

Two requests racing at the limit can both pass: each counts before the gate and nothing holds a
lock. Accepted rather than solved. The cost is one project over on a race nobody is trying to
win, against a serialisation point on project creation for every account; a limit that is one
out under concurrency is a different thing from a limit that is not enforced.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `PATCH /profile`, with `plan` behind a role

**Files:**
- Modify: `backend/src/profile/routes.ts:84-113`
- Modify: `frontend/src/ui/profile.ts:72`
- Test: `backend/test/profile/profile.test.ts`

**Interfaces:**
- Consumes: `ProfileStore.rolesOf`, `ProfileStore.setPlan`, `isPlan` (Task 3).
- Produces: `PATCH /profile` replaces `PUT /profile`; `OPERATOR_ROLES = ['_admin', 'customerservice']`.

- [ ] **Step 1: Write the failing test**

```ts
describe('PATCH /profile', () => {
  it('changes the locale without requiring anything else', async () => {
    // PATCH because the semantics were already partial: the old handler treated an absent
    // displayName as "leave it alone" while requiring locale on every request.
    const app = await profileServer({ roles: [] })
    const response = await app.inject({
      method: 'PATCH',
      url: '/profile',
      headers: { cookie: session('user-1') },
      payload: { locale: 'de' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().locale).toBe('de')
  })

  it('refuses a plan from an ordinary user, and does not quietly ignore it', async () => {
    // Silently dropping the field would be the wrong refusal: a caller that asked for
    // something and was not told it was refused concludes the field does not exist.
    const app = await profileServer({ roles: [] })
    const response = await app.inject({
      method: 'PATCH',
      url: '/profile',
      headers: { cookie: session('user-1') },
      payload: { plan: 'pro' },
    })
    expect(response.statusCode).toBe(403)
    expect(await storedPlan('user-1')).toBe('free')
  })

  it('accepts a plan from a role holder', async () => {
    const app = await profileServer({ roles: ['customerservice'] })
    const response = await app.inject({
      method: 'PATCH',
      url: '/profile',
      headers: { cookie: session('user-1') },
      payload: { plan: 'pro' },
    })
    expect(response.statusCode).toBe(200)
    expect(await storedPlan('user-1')).toBe('pro')
  })

  it('matches a role exactly, not as a prefix or case-insensitively', async () => {
    // `customerservices` is somebody else's role and `Customerservice` is a typo. Either
    // passing would make the gate an approximation of itself.
    for (const roles of [['customerservices'], ['Customerservice'], ['customer']]) {
      const app = await profileServer({ roles })
      const response = await app.inject({
        method: 'PATCH',
        url: '/profile',
        headers: { cookie: session('user-1') },
        payload: { plan: 'pro' },
      })
      expect(response.statusCode).toBe(403)
    }
  })

  it('refuses a plan string it does not know', async () => {
    const app = await profileServer({ roles: ['customerservice'] })
    const response = await app.inject({
      method: 'PATCH',
      url: '/profile',
      headers: { cookie: session('user-1') },
      payload: { plan: 'enterprise' },
    })
    expect(response.statusCode).toBe(400)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd backend && npx vitest run test/profile/profile.test.ts
```

Expected: FAIL — 404, because the route is registered as `PUT`.

- [ ] **Step 3: Write the implementation**

In `backend/src/profile/routes.ts`, above the handler:

```ts
/**
 * The roles that may set a plan.
 *
 * `_admin` is CouchDB's own. `customerservice` is granted by editing a `_users` document, and
 * neither is grantable through this API — `store.update` spreads the existing document and takes
 * only named fields, so a user cannot give themselves the role that would let them do this. That
 * property is what the whole gate rests on.
 */
const OPERATOR_ROLES: readonly string[] = ['_admin', 'customerservice']
```

Replace `app.put('/profile', ...)` with `app.patch('/profile', ...)`, and inside it:

```ts
    const body = request.body as
      | { locale?: unknown; displayName?: unknown; plan?: unknown }
      | undefined

    // PATCH: an absent field is one the caller is not changing. `locale` was required before,
    // which made the endpoint a PATCH wearing a PUT's name.
    if (body?.locale !== undefined && !isLocale(body.locale)) {
      return reply.code(400).send({ title: 'locale must be one of auto, en, de', status: 400 })
    }

    if (body?.plan !== undefined) {
      if (!isPlan(body.plan)) {
        return reply.code(400).send({ title: 'plan must be one of free, user, pro', status: 400 })
      }
      // Exact membership. A substring or a case fold would make `customerservices` — somebody
      // else's role — into this one.
      const roles = await deps.store.rolesOf(sub)
      if (!roles.some((role) => OPERATOR_ROLES.includes(role))) {
        return reply.code(403).send({
          title: 'Changing a plan is not something this account may do.',
          status: 403,
          reason: 'not-an-operator',
        })
      }
      await deps.store.setPlan(sub, body.plan)
    }
```

then the update, with `locale` defaulted from what is stored when the caller did not send one:

```ts
    // `store.update` still requires a locale, so a PATCH that changed only the display name has
    // to supply the current one. Reading it here rather than making the parameter optional
    // keeps the store's contract — "this is the locale now" — intact.
    const current = await deps.store.read(sub)
    const profile = await deps.store.update(sub, {
      locale: isLocale(body?.locale) ? body.locale : (current?.locale ?? 'auto'),
      ...(displayName === undefined || displayName === '' ? {} : { displayName }),
    })

    reply.header('cache-control', 'private, no-store')
    return profile
```

In `frontend/src/ui/profile.ts:72`, change `method: 'PUT'` to `method: 'PATCH'`. **Both move in the same commit**: a settings page sending `PUT` to a route that no longer exists fails silently, because a fire-and-forget save does not surface a 405.

- [ ] **Step 4: Run the tests**

```bash
cd backend && npx vitest run && npm run typecheck
cd ../frontend && npx vitest run test/ui/profile.test.ts && npm run typecheck
```

Expected: PASS on both sides.

- [ ] **Step 5: Commit**

```bash
cd /Users/stw/Code/matter-manager && npm --prefix backend run check:fix && npm --prefix frontend run check:fix
git add backend/src/profile/routes.ts backend/test/profile/profile.test.ts frontend/src/ui/profile.ts
git commit -m "$(cat <<'EOF'
feat(profile): PATCH, and a plan only an operator may set

PATCH because the semantics were already partial - the handler treated an absent displayName as
"leave it alone" while requiring locale on every request, which is a PATCH wearing a PUT's name.

`plan` is refused with a named 403 rather than silently dropped. A caller that asked for
something and was not told it was refused concludes the field does not exist.

Role membership is exact. A substring or a case fold would turn `customerservices` - somebody
else's role - into this one.

The frontend moves in the same commit. A settings page sending PUT to a route that no longer
exists fails silently, because a fire-and-forget save does not surface a 405.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `PUT /customer`, the route that can reach somebody else

**Files:**
- Create: `backend/src/profile/customer.ts`
- Modify: `backend/src/server.ts` (register the route)
- Test: `backend/test/profile/customer.test.ts`

**Interfaces:**
- Consumes: `ProfileStore.rolesOf`, `setPlan`, `UnknownSubjectError`, `isPlan` (Task 3); `OPERATOR_ROLES` (Task 5, exported from `profile/routes.ts`).
- Produces: `PUT /customer` taking `{sub, plan}`.

- [ ] **Step 1: Write the failing test**

```ts
describe('PUT /customer', () => {
  it('sets another account\'s plan for a role holder', async () => {
    // The reason this route exists: PATCH /profile can only ever reach the caller, so without
    // it an operator can upgrade themselves and nobody else.
    const app = await customerServer({ callerRoles: ['customerservice'], subjects: ['other'] })
    const response = await app.inject({
      method: 'PUT',
      url: '/customer',
      headers: { cookie: session('operator') },
      payload: { sub: 'other', plan: 'user' },
    })
    expect(response.statusCode).toBe(200)
    expect(await storedPlan('other')).toBe('user')
  })

  it('refuses a caller without the role', async () => {
    const app = await customerServer({ callerRoles: [], subjects: ['other'] })
    const response = await app.inject({
      method: 'PUT',
      url: '/customer',
      headers: { cookie: session('operator') },
      payload: { sub: 'other', plan: 'pro' },
    })
    expect(response.statusCode).toBe(403)
    expect(await storedPlan('other')).toBe('free')
  })

  it('answers 404 for a subject that has never signed in', async () => {
    // Distinct from 403 on purpose: "you may not" and "there is no such account" send an
    // operator to different places, and `store.setPlan` throws a nameable error for exactly
    // this so the route does not have to guess from a bare Error.
    const app = await customerServer({ callerRoles: ['_admin'], subjects: [] })
    const response = await app.inject({
      method: 'PUT',
      url: '/customer',
      headers: { cookie: session('operator') },
      payload: { sub: 'ghost', plan: 'user' },
    })
    expect(response.statusCode).toBe(404)
  })

  it('refuses an unsigned caller before it looks at anything', async () => {
    const app = await customerServer({ callerRoles: ['_admin'], subjects: ['other'] })
    const response = await app.inject({
      method: 'PUT',
      url: '/customer',
      payload: { sub: 'other', plan: 'pro' },
    })
    expect(response.statusCode).toBe(401)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd backend && npx vitest run test/profile/customer.test.ts
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the implementation**

`backend/src/profile/customer.ts`:

```ts
/**
 * `PUT /customer` — setting somebody else's plan.
 *
 * Separate from `PATCH /profile` because that route takes its subject from the session and never
 * from the body; its own comment calls the alternative "an account-takeover primitive". So it can
 * only ever reach the caller, which upgrades an operator and nobody else. This route exists to
 * name a subject, and keeping it separate is what lets `/profile` keep its rule intact rather
 * than smuggling a subject into a body whose comment forbids it.
 *
 * @module
 */
```

```ts
import type { FastifyInstance } from 'fastify'
import { isPlan, type ProfileStore, UnknownSubjectError } from './store.js'

export interface CustomerDependencies {
  readonly store: ProfileStore
  /** Resolves the caller from the session cookie. The same function `PATCH /profile` uses. */
  readonly subjectOf: (request: unknown) => string | undefined
  readonly operatorRoles: readonly string[]
}

export function registerCustomerRoutes(app: FastifyInstance, deps: CustomerDependencies): void {
  app.put('/customer', async (request, reply) => {
    const caller = deps.subjectOf(request)
    if (caller === undefined) {
      return reply.code(401).send({ title: 'Not signed in', status: 401 })
    }

    // Before the body is looked at, deliberately. Validating first would let an unauthorised
    // caller tell 400 from 404 and so enumerate which accounts exist - a difference that is
    // useful to an operator and to nobody else.
    const roles = await deps.store.rolesOf(caller)
    if (!roles.some((role) => deps.operatorRoles.includes(role))) {
      return reply.code(403).send({
        title: 'Changing a plan is not something this account may do.',
        status: 403,
        reason: 'not-an-operator',
      })
    }

    const body = request.body as { sub?: unknown; plan?: unknown } | undefined
    if (typeof body?.sub !== 'string' || body.sub === '') {
      return reply.code(400).send({ title: 'sub must name an account.', status: 400 })
    }
    if (!isPlan(body.plan)) {
      return reply.code(400).send({ title: 'plan must be one of free, user, pro', status: 400 })
    }

    try {
      const profile = await deps.store.setPlan(body.sub, body.plan)
      reply.header('cache-control', 'no-store')
      return profile
    } catch (error) {
      if (!(error instanceof UnknownSubjectError)) throw error
      // Distinct from the 403 above. "You may not" and "there is no such account" send an
      // operator to different places, which is the whole reason setPlan throws something
      // nameable rather than the bare Error `update` throws for the same condition.
      return reply.code(404).send({ title: 'No such account.', status: 404 })
    }
  })
}
```

Register it in `backend/src/server.ts` beside the profile routes, passing `OPERATOR_ROLES` exported from `profile/routes.ts` so the two gates cannot drift apart.

- [ ] **Step 4: Run the tests**

```bash
cd backend && npx vitest run && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/stw/Code/matter-manager && npm --prefix backend run check:fix
git add backend/src/profile/customer.ts backend/src/server.ts backend/test/profile/customer.test.ts
git commit -m "$(cat <<'EOF'
feat(profile): PUT /customer, so an operator can reach an account that is not their own

PATCH /profile takes its subject from the session and never from the body - its own comment
calls the alternative an account-takeover primitive - so it can only ever reach the caller. An
operator who can upgrade themselves and nobody else is not an operator tool. This route names a
subject, and being a separate route is what lets /profile keep its rule intact.

404 and 403 are different answers because they send an operator to different places. setPlan
throws a nameable error for the missing-account case so the route does not have to read a bare
Error and guess.

The role check runs before the body is validated, so an unauthorised caller cannot use the
difference between 400 and 404 to enumerate accounts.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The contract says so

**Files:**
- Modify: `openapi.yaml`
- Modify: `backend/src/profile/routes.ts` (the `GET /profile` response)
- Modify: `backend/src/generated/openapi.ts` (regenerated)
- Test: `backend/test/openapi-drift.test.ts` (no edit; it must pass)

**Interfaces:**
- Consumes: everything above.
- Produces: `GET /profile` returns `plan` and `projectLimit`.

- [ ] **Step 1: Write the failing test**

```ts
it('reports the plan and the capacity that goes with it', async () => {
  const app = await profileServer({ roles: [], plan: 'user' })
  const body = (await app.inject({
    method: 'GET',
    url: '/profile',
    headers: { cookie: session('user-1') },
  })).json()
  expect(body.plan).toBe('user')
  expect(body.projectLimit).toBe(5)
})

it('reports -1 rather than null or an absence for an unlimited plan', async () => {
  // The page interprets this through the same rule the policy does. A null or a missing key
  // would make it handle two shapes to learn one fact.
  const app = await profileServer({ roles: [], plan: 'pro' })
  const body = (await app.inject({
    method: 'GET',
    url: '/profile',
    headers: { cookie: session('user-1') },
  })).json()
  expect(body.projectLimit).toBe(-1)
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd backend && npx vitest run test/profile/profile.test.ts
```

Expected: FAIL — `plan` and `projectLimit` are undefined.

- [ ] **Step 3: Write the implementation**

Add to the `GET /profile` response: `plan: profile.plan` and `projectLimit: PROJECT_LIMITS[profile.plan]`.

In `openapi.yaml`, the `Profile` schema is at line 412. Both fields are **required**, because a
client that has to handle their absence is a client deciding what a missing plan means:

```yaml
    Profile:
      type: object
      required: [sub, email, displayName, locale, plan, projectLimit]
      properties:
        sub: { type: string, description: Internal user id; also the CouchDB username }
        email: { type: string, format: email }
        displayName: { type: string }
        locale:
          type: string
          enum: [auto, en, de]
          description: '`auto` follows the browser; anything else overrides it.'
        plan:
          type: string
          enum: [free, user, pro]
          description: Set by an operator through `PUT /customer`; never by the account itself.
        projectLimit:
          type: integer
          description: >-
            How many projects this plan may own. **`-1` means unlimited** and must be tested
            before it is compared — `owned >= limit` is true for every count when the limit is
            `-1`, so a client that compares directly refuses every project on the one plan that
            has no limit.
```

Then add `PATCH /profile` and `PUT /customer` as operations beside the existing `GET /profile`,
each with its `403` carrying `reason`, and add the `403` with `reason: project-limit-reached` to
`POST /projects`.

Regenerate the types:

```bash
cd backend && npm run openapi:types
```

- [ ] **Step 4: Run everything**

```bash
cd backend && npx vitest run && npm run typecheck
```

Expected: PASS, including `openapi-drift.test.ts`, which walks every operation in the contract and validates real responses against it — so a field the contract does not describe fails there rather than reaching a client.

- [ ] **Step 5: Commit**

```bash
cd /Users/stw/Code/matter-manager && npm --prefix backend run check:fix
git add openapi.yaml backend/src/profile/routes.ts backend/src/generated/openapi.ts backend/test/profile/profile.test.ts
git commit -m "$(cat <<'EOF'
feat(api): GET /profile reports the plan and its capacity

projectLimit is always a number, with -1 for unlimited, so a client learns one fact from one
shape. The contract describes the sentinel rather than leaving a reader to discover it.

openapi.yaml gains PATCH /profile, PUT /customer and the named 403 on POST /projects.
openapi-drift.test.ts is what makes that more than documentation: it walks every operation and
validates real responses, so a field the contract does not describe fails in CI rather than
reaching a client.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## After the last task

- [ ] **Run the full verification.** `npm run verify` at the repository root: `check:deps`, `check:npmrc`, `check:node`, `check:dependabot`, root Biome, then the frontend and backend suites.
- [ ] **Set a plan by hand once**, to prove the operator path works against a real CouchDB rather than a fake: `PUT /customer` with a `customerservice` role, then `GET /profile` reporting the new limit.
- [ ] **Phase 2 gets its own plan.** The projects landing page, the slot grid, location derivation and the three manual actions — written against the API this phase actually produced rather than against a prediction of it.
