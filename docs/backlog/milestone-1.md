# M1 — Domain core

**Goal:** everything a Matter payload can tell us, implemented as pure functions with no
infrastructure. When this milestone is done, the hardest logic in the product is finished
and exhaustively tested.

All work is in `packages/core`. Coverage gate 90%.

---

## M1-1 · Decode a QR payload into its fields

`type:story` `area:core` `area:qr` `size:M`

**Story:** as a user scanning a code, I want its contents understood, so the app can fill in
what it already knows instead of asking me.

```gherkin
Scenario: the reference device payload decodes correctly
  Given the payload "MT:Y.K9042C00KA0648G00"
  When it is decoded
  Then version is 0
  And vendorId is 0xFFF1
  And productId is 0x8000
  And discriminator is 3840
  And passcode is 20202021
  And discoveryCapabilities indicates BLE

Scenario: the MT: prefix is required
  When a payload without the "MT:" prefix is decoded
  Then a PayloadError names the missing prefix

Scenario: a truncated payload is rejected
  Given a payload whose Base38 body is shorter than 19 characters
  When it is decoded
  Then a PayloadError is thrown
  And no partially-populated result is returned
```

**Out of scope:** the TLV extension section for optional vendor data (M6 if ever needed);
manual pairing code parsing (M1-3).

**Test plan:** table-driven over the verified vector plus each malformed shape. Assert bit
boundaries explicitly — an off-by-one in the 88-bit unpack shifts every subsequent field,
so a test that checks only `vendorId` would pass against badly broken code.

---

## M1-2 · Encode fields back into a payload

`type:story` `area:core` `area:qr` `size:S`

**Story:** as a user, I want the exact original QR reproduced, so a scanner accepts it.

```gherkin
Scenario: round trip is exact
  Given any valid payload
  When it is decoded and re-encoded
  Then the result is character-for-character identical to the original

Scenario: out-of-range fields are rejected
  When encoding with a discriminator above 4095
  Then a PayloadError names the field and its permitted range
```

**Out of scope:** rendering a QR image (M2).

---

## M1-3 · Derive and parse the manual pairing code

`type:story` `area:core` `size:M`

**Story:** as a user whose phone cannot focus on a small printed code, I want the numeric
code, so I can still commission the device.

```gherkin
Scenario: the 11-digit code is derived correctly
  Given discriminator 3840 and passcode 20202021
  When the short manual pairing code is derived
  Then it is "34970112332"

Scenario: the check digit is validated on parse
  When a manual code with a wrong final digit is parsed
  Then a PayloadError reports a check digit failure

Scenario: the 21-digit form carries vendor and product ids
  Given a long-form code including vendor and product ids
  When it is parsed
  Then those ids are recovered
```

**Note:** `34970112332` is a **verified** anchor — it was independently derived during design
and matched. Treat it as fixed.

**Test plan:** Verhoeff check digit gets its own tests, including every single-digit
substitution and adjacent transposition, since catching exactly those is the algorithm's
entire purpose.

---

## M1-4 · Reject invalid passcodes

`type:story` `area:core` `security` `size:S`

**Story:** as a user, I want an obviously bad code rejected at scan time, so I do not file a
device whose stored code cannot work.

```gherkin
Scenario: specification-forbidden passcodes are rejected
  When a payload decodes to passcode 00000000
  Then it is reported invalid
  And the same holds for 11111111, 22222222 through 88888888,
      99999999, 12345678 and 87654321

Scenario: passcodes outside the representable range are rejected
  When a passcode exceeds 27 bits
  Then it is reported invalid
```

**Why it matters:** these values are forbidden by the specification precisely because they
are guessable. A device whose label shows one is either counterfeit or misprinted, and the
user should learn that while standing in front of it.

---

## M1-5 · Room path helpers

`type:story` `area:core` `size:S`

**Story:** as a user organising a house, I want room paths to behave predictably, so
grouping and renaming work the way they look like they should.

```gherkin
Scenario: a path splits into segments
  Given "Ground Floor/Kitchen"
  When the path is split
  Then the segments are ["Ground Floor", "Kitchen"]

Scenario: paths are normalised on creation
  Given " ground floor / kitchen "
  When the path is normalised
  Then it becomes "ground floor/kitchen" with segments trimmed
  And a near-duplicate of an existing "Ground Floor/Kitchen" is reported

Scenario: empty segments are rejected
  When a path contains "//" or begins or ends with "/"
  Then a validation error is returned

Scenario: renaming a parent rewrites descendant paths
  Given rooms "Floor 1/Kitchen" and "Floor 1/Bath"
  When "Floor 1" is renamed to "Ground Floor"
  Then both become "Ground Floor/..."
```

---

## M1-6 · Conflict merge strategies

`type:story` `area:core` `area:sync` `size:M`

**Story:** as a user who added a remark while offline, I want it to survive, so the device
history is trustworthy.

```gherkin
Scenario: concurrent remarks all survive
  Given a device revision with remarks A and B
  And a conflicting revision with remarks A and C
  When the revisions are merged
  Then the result contains A, B and C exactly once each
  And they are ordered by createdAt

Scenario: scalar fields take the most recent write
  Given two revisions differing in name with different updatedAt
  When merged
  Then the name from the later updatedAt wins

Scenario: a device is never orphaned by a deleted room
  Given a device referencing a room deleted in the winning revision
  When merged
  Then the room is restored as "Unassigned/<old path>"
  And the device still references it
```

**Out of scope:** detecting conflicts and writing merged results — that is `data` in M2.
These are pure `(winner, conflicts[]) => merged` functions.

**Why the ordering assertion matters:** union alone would satisfy "nothing lost" while
producing a history in arbitrary order, which reads as corrupted even though no data is
missing.

---

## M1-7 · Entitlement seam

`type:story` `area:core` `size:S`

**Story:** as the operator, I want every gated action to already ask permission, so adding
a subscription later changes one file rather than requiring an audit of the whole app.

```gherkin
Scenario: everything is permitted today
  When can(principal, any action, project) is called
  Then it returns true

Scenario: the action list is exhaustive and typed
  Then actions are a union type, so a new gated action cannot be added
       without the compiler requiring a decision about it
```

**Out of scope:** any actual limit, plan or payment provider (M8).

**The point:** the call sites, not the logic. See
[ADR 0009](../adr/0009-entitlement-seam-billing-deferred.md).
