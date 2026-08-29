# todo-112 — Nothing asks the browser to keep this data

Closes #112.

## The gap

**Before this change**, `grep -rn "navigator.storage" packages/*/src` returned nothing. Everything this application
holds is in best-effort storage: evicted under pressure, LRU across origins, and the user is
not told. For a catalogue whose promise is that a device recorded is a device kept, that is the
difference between best-effort and kept.

## The decision the issue deferred

**Ask at first launch.** Chosen by the maintainer from the four options the issue set out.

The issue's own objection to it is real and worth writing down rather than arguing away: on
Firefox the prompt arrives before the user has anything at stake. What decides it the other way
is that the alternative moments are worse — after the first device is saved, the data being
protected has *already* been written to storage that can be evicted, and a settings toggle is a
control almost nobody finds. Chromium and Safari decide silently, so for most users this is not
a prompt at all.

## Shape

`packages/web/src/storage.ts`, following the supplier convention `preferences.ts` establishes and
explains: the storage object is reached **inside** the guard, because on an origin that refuses
it the throwing site is the property access rather than the call. That also makes the whole thing
testable against a stub.

Three states, not two. `persisted` and `best-effort` are answers; `unknown` is what an engine
without the Storage API gives, and calling that "not persisted" would be reporting a fact the
browser never stated.

## Asked once, and the flag is written *before* the await

`persist()` on Firefox does not settle until the user answers. If the flag were written after,
somebody who ignores the prompt and reloads gets asked again, every time — which is L31's
"a flag set after an await is a race" in its user-facing form. So the flag records **that the
question was put**, not that it was answered.

Already-granted is checked first, so an origin that is persisted never asks at all.

## Tasks

- [x] Red: a test asserting nothing currently requests persistence
- [x] `storage.ts` — `readStorageReport`, `requestPersistence`, against a supplier
- [x] Asked once, from `main.ts` at first launch
- [x] Refusal is an ordinary state: no error, no warning the user cannot act on
- [x] `persisted()` and `estimate()` surfaced in Settings, since the answer differs per browser
      and per device and nothing else reveals it
- [x] Tests against a stubbed `navigator.storage`, including refusal, absence, and a throw
- [x] German for every new string

## Review

**Done.** `npm run verify` clean, 2079 tests pass, `storage.ts` at 96% and the settings view at
97%.

### The part worth a reviewer's attention

**The asked-once flag is written before the `await`, not after.** `persist()` on Firefox does not
settle until the user answers the prompt. A flag written afterwards means somebody who ignores
the prompt and reloads is asked again, and again, forever — the application nagging for a
permission the user has been declining by silence.

So the flag records that the question was **put**, not that it was answered. That is L31's
"a flag set after an await is a race" in the form a user actually meets, and it has its own test:
the promise is held open and the flag is asserted present before it resolves.

### Three states, not two

`unknown` exists because an engine with no Storage API has not said anything, and reporting
`best-effort` there would state a fact the browser never stated — the interface would be telling
somebody their data is at risk on the strength of a question nobody asked.

That distinction is also why `requestPersistence` has two guards rather than one around the lot.
A `persisted()` that throws leaves the standing genuinely unknown; a `persist()` that throws
leaves it known and unchanged. One `try` would have collapsed those into the same answer.

### The refusal path is the one that needed a stub

A browser refuses when *it* decides to, and no test can make that decision go a particular way —
yet refusal is what most users on most engines will get. So the common case is only reachable through an injectable supplier — which is
why the settings view takes a `storageManager` the way the device forms take `repositories`.
Without it the tests would cover only the state that is rarest.

### What the message says, and why

`best-effort` is the ordinary case, so it must not read as a fault, and it names the one thing
the user can act on — installing the application, which every engine weighs when deciding. A
status with no remedy is only an anxiety. There is a test for each half of that: no danger
callout, and the word "install" present.
