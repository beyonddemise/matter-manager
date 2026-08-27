import { describe, expect, it } from 'vitest'
import {
  canManageMembers,
  canWrite,
  grantRole,
  MembershipError,
  narrowsAccess,
  PROJECT_ROLES,
  revokeAccess,
  securityFor,
} from '../../src/projects/membership.js'
import type { Participant } from '../../src/projects/ownership.js'

const ADA = 'google|ada'
const GRACE = 'google|grace'

const owned: readonly Participant[] = [{ role: 'owner', userid: ADA }]

describe('what each role permits', () => {
  it('lets an owner and a manager change who else has access', () => {
    expect(canManageMembers('owner')).toBe(true)
    expect(canManageMembers('manage')).toBe(true)
  })

  it('does not let a writer or a reader change access', () => {
    // Writing devices and deciding who else may see the house are different things. A writer
    // who can add themselves a co-owner has effectively taken the project.
    expect(canManageMembers('write')).toBe(false)
    expect(canManageMembers('read')).toBe(false)
  })

  it('does not let somebody who is not a participant change access', () => {
    expect(canManageMembers(undefined)).toBe(false)
  })

  it('lets everybody except a reader write', () => {
    expect(PROJECT_ROLES.filter(canWrite)).toEqual(['write', 'manage', 'owner'])
  })

  it('accounts for every role', () => {
    // If a role is added to `ProjectRole` and not to this list, the two functions above stop
    // being exhaustive — and the failure mode is a new role silently inheriting write access.
    expect([...PROJECT_ROLES].sort()).toEqual(['manage', 'owner', 'read', 'write'])
  })
})

describe('what CouchDB is told', () => {
  it('makes everybody a member', () => {
    const security = securityFor([
      { role: 'owner', userid: ADA },
      { role: 'read', userid: GRACE },
    ])

    expect(security.members.names).toEqual([ADA, GRACE])
  })

  it('makes only the writers writers', () => {
    // **The mapping that is the security model.** A reader in `writers.names` is a reader who
    // can edit somebody else's home, and the interface hiding the edit button would look
    // exactly the same.
    const security = securityFor([
      { role: 'owner', userid: ADA },
      { role: 'read', userid: GRACE },
    ])

    expect(security.writers.names).toEqual([ADA])
  })

  it('treats a manager as a writer', () => {
    // CouchDB has no way to express "may change who else has access", so from the database's
    // point of view a manager is simply somebody who may write.
    expect(securityFor([{ role: 'manage', userid: GRACE }]).writers.names).toEqual([GRACE])
  })

  it('grants nothing by role', () => {
    // A `roles` entry grants access to everybody holding it. This application's access is per
    // person, and a role here is the one way to share every project with every account at once.
    expect(securityFor(owned).members.roles).toEqual([])
  })

  it('says nothing about admins', () => {
    // `_security.admins` would let somebody rewrite `_security` itself, which is the API's job
    // and nobody else's — a project admin could grant themselves anything.
    expect(securityFor(owned)).not.toHaveProperty('admins')
  })

  it('gives an empty project an empty membership rather than an absent one', () => {
    // `{}` and `{members: {names: []}}` are different to CouchDB: an absent `members` means
    // *any authenticated user may read*, which is the default a fresh database has.
    expect(securityFor([])).toEqual({ members: { names: [], roles: [] }, writers: { names: [] } })
  })
})

describe('granting a role', () => {
  it('adds somebody new', () => {
    expect(grantRole(owned, GRACE, 'read')).toEqual([
      { role: 'owner', userid: ADA },
      { role: 'read', userid: GRACE },
    ])
  })

  it('changes a role somebody already has, rather than listing them twice', () => {
    const shared = grantRole(owned, GRACE, 'read')

    expect(grantRole(shared, GRACE, 'write')).toEqual([
      { role: 'owner', userid: ADA },
      { role: 'write', userid: GRACE },
    ])
  })

  it('keeps the order, so a list does not reshuffle when a role changes', () => {
    const three = grantRole(grantRole(owned, GRACE, 'read'), 'google|hopper', 'write')

    expect(grantRole(three, GRACE, 'manage').map((p) => p.userid)).toEqual([
      ADA,
      GRACE,
      'google|hopper',
    ])
  })

  it('refuses to demote the last owner', () => {
    // A project with no owner cannot be transferred, shared or deleted by anybody. There is no
    // way back from it through the API, so it is refused rather than repaired afterwards.
    expect(() => grantRole(owned, ADA, 'manage')).toThrow(MembershipError)
  })

  it('allows demoting an owner when there is another', () => {
    const two = grantRole(owned, GRACE, 'owner')

    expect(grantRole(two, ADA, 'read')).toEqual([
      { role: 'read', userid: ADA },
      { role: 'owner', userid: GRACE },
    ])
  })

  it('refuses an empty subject', () => {
    // An empty name in `_security.members.names` is a name nobody has, and one more way for a
    // list to look longer than the people on it.
    expect(() => grantRole(owned, '', 'read')).toThrow(MembershipError)
  })

  it('does not change the list it was given', () => {
    const before = [...owned]
    grantRole(owned, GRACE, 'read')

    expect(owned).toEqual(before)
  })
})

describe('revoking access', () => {
  it('removes somebody', () => {
    const shared = grantRole(owned, GRACE, 'read')

    expect(revokeAccess(shared, GRACE)).toEqual(owned)
  })

  it('does nothing for somebody who was never a participant', () => {
    // Not an error: the state the caller asked for is the state that already holds.
    expect(revokeAccess(owned, 'google|stranger')).toEqual(owned)
  })

  it('refuses to remove the last owner', () => {
    expect(() => revokeAccess(owned, ADA)).toThrow(MembershipError)
  })

  it('allows removing an owner when there is another', () => {
    const two = grantRole(owned, GRACE, 'owner')

    expect(revokeAccess(two, ADA)).toEqual([{ role: 'owner', userid: GRACE }])
  })
})

describe('which write goes first', () => {
  // There is no transaction: the registry and the project database are two databases. So the
  // only question is which half-applied state is the safe one to be caught in.

  it('narrows when somebody loses read access', () => {
    const shared = grantRole(owned, GRACE, 'read')

    expect(narrowsAccess(shared, owned)).toBe(true)
  })

  it('narrows when somebody is demoted from writer to reader', () => {
    // They keep read access, so `members.names` is unchanged — and the change still has to be
    // applied to CouchDB first, because until it is they can still write.
    const writer = grantRole(owned, GRACE, 'write')
    const reader = grantRole(writer, GRACE, 'read')

    expect(narrowsAccess(writer, reader)).toBe(true)
  })

  it('does not narrow when somebody is promoted', () => {
    const reader = grantRole(owned, GRACE, 'read')
    const writer = grantRole(reader, GRACE, 'write')

    expect(narrowsAccess(reader, writer)).toBe(false)
  })

  it('does not narrow when somebody is added', () => {
    expect(narrowsAccess(owned, grantRole(owned, GRACE, 'read'))).toBe(false)
  })

  it('does not narrow when nothing changes', () => {
    expect(narrowsAccess(owned, owned)).toBe(false)
  })
})
