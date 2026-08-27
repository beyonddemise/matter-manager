import { beforeEach, describe, expect, it } from 'vitest'
import { ensureInvitationIndex, forgetInvitationIndex } from '../../src/projects/invitations.js'
import { ensureRegistry, forgetRegistry, REGISTRY_DATABASE } from '../../src/projects/registry.js'
import { ensureTransferIndex, forgetTransferIndex } from '../../src/projects/transfers.js'
import { ensureUserIndex, forgetUserIndex } from '../../src/projects/users.js'
import { fakeCouch } from '../support/couch.js'

/**
 * Installing a design document a second time.
 *
 * Every `ensure*` helper is written to run once per process and remembers that it has, so within
 * one process the second call is free. **The second *process* is the case nobody had.** These
 * tests are what a restart looks like: the same database, a fresh module state.
 *
 * `forget*` is what makes that expressible — it is the process boundary, in a function. The
 * fake enforces `_rev` exactly as CouchDB does, so a helper that writes a design document
 * without one fails here for the same reason it fails in a real deployment.
 *
 * Nothing caught this before because every test began with an empty database, where the first
 * write is a *create* and needs no `_rev`. A deployment is only empty once.
 */

/** Each helper, and what stops working when it throws. */
const HELPERS = [
  {
    what: 'the project registry',
    ensure: ensureRegistry,
    forget: forgetRegistry,
    breaks: 'creating a project, and every transfer path',
  },
  {
    what: 'the invitation index',
    ensure: ensureInvitationIndex,
    forget: forgetInvitationIndex,
    breaks: 'redeeming an invitation',
  },
  {
    what: 'the transfer index',
    ensure: ensureTransferIndex,
    forget: forgetTransferIndex,
    breaks: 'accepting an ownership transfer',
  },
  {
    what: 'the user address index',
    ensure: ensureUserIndex,
    forget: forgetUserIndex,
    breaks: 'finding anybody by email, so sharing and inviting',
  },
] as const

describe('a design document that is already installed', () => {
  beforeEach(() => {
    for (const helper of HELPERS) helper.forget()
  })

  for (const { what, ensure, forget, breaks } of HELPERS) {
    it(`installs ${what} again after a restart`, async () => {
      const { couch } = fakeCouch()

      await ensure(couch)
      // The process boundary. Everything CouchDB holds survives it; the module's memory of
      // having written does not.
      forget()

      // Without a `_rev` this throws `409 conflict`, and because `established` is only set
      // after a successful write, it throws again on every subsequent call — so ${breaks}
      // stays broken for as long as the deployment runs.
      await expect(ensure(couch)).resolves.toBeUndefined()
    })

    it(`leaves ${what} usable after a restart`, async () => {
      const { couch } = fakeCouch()

      await ensure(couch)
      forget()
      await ensure(couch)

      // Not merely "did not throw": the design document has to still be there afterwards, with
      // its view. A helper that swallowed the conflict and wrote nothing would pass the test
      // above while leaving the deployment with whatever was there before.
      const design = await couch.getDoc<{ _id: string; views?: Record<string, { map?: string }> }>(
        ...designLocation(what),
      )
      expect(Object.values(design?.views ?? {})[0]?.map).toContain('emit(')
    })
  }
})

describe('a design document whose map function has changed', () => {
  beforeEach(() => {
    for (const helper of HELPERS) helper.forget()
  })

  for (const { what, ensure, forget } of HELPERS) {
    it(`replaces ${what} rather than being refused`, async () => {
      // The case `_rev` exists for, and the only one that reaches the write at all: when the
      // stored map already matches, `installDesign` returns without writing, so a missing
      // `_rev` would never be noticed. Rewriting a *changed* map is the stated reason these
      // helpers run on every process — "it is how a change to the map function reaches a
      // deployment" — so it is the path that has to work.
      const [database, id] = designLocation(what)
      const { couch } = fakeCouch({
        seed: {
          [`${database}/${id}`]: {
            _id: id,
            _rev: '1-a',
            language: 'javascript',
            views: { stale: { map: 'function (doc) { emit(null, null) }' } },
          },
        },
        databases: [database],
      })

      await expect(ensure(couch)).resolves.toBeUndefined()

      const design = await couch.getDoc<{
        _id: string
        views?: Record<string, { map?: string }>
      }>(database, id)
      expect(design?.views).not.toHaveProperty('stale')
    })

    it(`installs ${what} once when two callers arrive together`, async () => {
      // `findUser` awaits one of these on the path of every invitation, so two people sharing a
      // project at the same moment is enough to reach this. A flag set *after* the write does
      // not prevent it: both callers see "not yet", both write, and the second is refused with
      // the conflict all of this exists to avoid.
      const [database, id] = designLocation(what)
      const { couch, calls } = fakeCouch()
      forget()

      await Promise.all([ensure(couch), ensure(couch), ensure(couch)])

      const writes = calls.filter(
        (call) =>
          call.operation === 'putDoc' &&
          call.database === database &&
          (call.detail as { _id?: string } | undefined)?._id === id,
      )
      expect(writes).toHaveLength(1)
    })
  }
})

describe('two processes installing at the same moment', () => {
  beforeEach(() => {
    for (const helper of HELPERS) helper.forget()
  })

  for (const { what, ensure, forget } of HELPERS) {
    it(`survives losing the race for ${what}`, async () => {
      // `once()` shares work within **one** process, which is all it can do. Two API instances
      // starting together both read "not there", both write, and the loser gets a 409 — the
      // same conflict as the restart case, reached by a different route and not fixed by the
      // same means. Deployments run more than one instance; this is the ordinary case, not the
      // unlucky one.
      const [database, id] = designLocation(what)
      const { couch } = fakeCouch({ databases: [database] })

      // The other process, winning the race between our read and our write.
      const original = couch.getDoc.bind(couch)
      let raced = false
      couch.getDoc = (async (db: string, docId: string) => {
        const result = await original(db, docId)
        if (db === database && docId === id && !raced) {
          raced = true
          // Written by somebody else, after we looked and before we write.
          await couch.putDoc(database, {
            _id: id,
            language: 'javascript',
            views: { theirs: { map: 'function (doc) { emit(null, null) }' } },
          } as unknown as { _id: string })
        }
        return result
      }) as typeof couch.getDoc

      forget()
      await expect(ensure(couch)).resolves.toBeUndefined()
    })
  }
})

/** Where each helper's design document lives, so the assertion above reads one. */
function designLocation(what: (typeof HELPERS)[number]['what']): [string, string] {
  switch (what) {
    case 'the project registry':
      return [REGISTRY_DATABASE, '_design/by_participant']
    case 'the invitation index':
      return [REGISTRY_DATABASE, '_design/by_invitee']
    case 'the transfer index':
      return [REGISTRY_DATABASE, '_design/by_recipient']
    case 'the user address index':
      return ['_users', '_design/by_email']
  }
}
