import { describe, expect, it } from 'vitest'
import {
  isOwner,
  type Owner,
  ownerOf,
  type Participant,
  roleOf,
} from '../../src/projects/ownership.js'

const ADA: Owner = { ownerType: 'user', ownerId: 'google|1234' }

const PARTICIPANTS: readonly Participant[] = [
  { role: 'owner', userid: 'google|1234' },
  { role: 'write', userid: 'google|5678' },
  { role: 'read', userid: 'google|9012' },
]

describe('who owns a project', () => {
  it('is the participant with the owner role', () => {
    expect(ownerOf(PARTICIPANTS)).toEqual(ADA)
  })

  it('is undefined when nobody does', () => {
    // Which is a broken pointer rather than an ownerless project, and the caller has to decide
    // what to do about it. Inventing an owner here would be inventing an answer.
    expect(ownerOf([{ role: 'write', userid: 'google|5678' }])).toBeUndefined()
  })

  it('is the first owner when a document somehow lists two', () => {
    // Not reachable through this API — transfer replaces the entry — but a registry document is
    // a document, and a function that threw here would turn a data oddity into an outage.
    expect(
      ownerOf([
        { role: 'owner', userid: 'google|1111' },
        { role: 'owner', userid: 'google|2222' },
      ]),
    ).toEqual({ ownerType: 'user', ownerId: 'google|1111' })
  })
})

describe('whether the caller is the owner', () => {
  it('is true for the owner', () => {
    expect(isOwner({ sub: 'google|1234' }, ADA)).toBe(true)
  })

  it('is false for somebody else', () => {
    expect(isOwner({ sub: 'google|5678' }, ADA)).toBe(false)
  })

  it('is false for an organisation, whoever is asking', () => {
    // The seam ADR 0011 left open. An org-owned project is owned by the org, and no individual
    // `sub` is that org — so a comparison that ignored `ownerType` would make whoever happened
    // to share the id string an owner. Today no org exists, which is exactly when this is
    // cheap to get right.
    expect(isOwner({ sub: 'acme' }, { ownerType: 'org', ownerId: 'acme' })).toBe(false)
  })

  it('is false when the ids differ only in case', () => {
    // A subject is an opaque identifier from an identity provider, not a name. Nothing may
    // fold its case, because two providers could legitimately issue both.
    expect(isOwner({ sub: 'GOOGLE|1234' }, ADA)).toBe(false)
  })

  it('is false for an empty subject', () => {
    // A caller with no subject is not signed in. Matching an owner whose id is also empty
    // would make a malformed pointer owned by everybody who is nobody.
    expect(isOwner({ sub: '' }, { ownerType: 'user', ownerId: '' })).toBe(false)
  })
})

describe('what role somebody has', () => {
  it('finds a writer', () => {
    expect(roleOf(PARTICIPANTS, 'google|5678')).toBe('write')
  })

  it('finds a reader', () => {
    expect(roleOf(PARTICIPANTS, 'google|9012')).toBe('read')
  })

  it('finds the owner', () => {
    expect(roleOf(PARTICIPANTS, 'google|1234')).toBe('owner')
  })

  it('is undefined for somebody who is not a participant', () => {
    // Not `'read'`. A default of any kind here is a default that grants access, and the whole
    // point of the list is that being absent from it means something.
    expect(roleOf(PARTICIPANTS, 'google|0000')).toBeUndefined()
  })
})
