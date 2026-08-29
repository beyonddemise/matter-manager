# todo-112 — Nothing asks the browser to keep this data

Closes #112.

## The gap

`grep -rn "navigator.storage" packages/*/src` returns nothing. Everything this application
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
testable against a stub, which is the only way to exercise a refusal — a real browser cannot be
made to say no.

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

- [ ] Red: a test asserting nothing currently requests persistence
- [ ] `storage.ts` — `readStorageReport`, `requestPersistence`, against a supplier
- [ ] Asked once, from `main.ts` at first launch
- [ ] Refusal is an ordinary state: no error, no warning the user cannot act on
- [ ] `persisted()` and `estimate()` surfaced in Settings, since the answer differs per browser
      and per device and nothing else reveals it
- [ ] Tests against a stubbed `navigator.storage`, including refusal, absence, and a throw
- [ ] German for every new string

## Review
