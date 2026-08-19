# Contributing to Matter Manager

## The one rule that matters

**Every test is observed failing before the code that makes it pass is written.**

A test that has never failed has never been shown to test anything. It is entirely possible
to write a test that passes against an empty implementation, against the wrong module, or
against a typo'd assertion — and you will not find out until the bug it was supposed to
catch ships. Watching it go red first is the only evidence that the test is wired to the
behaviour it claims to check.

This is not a stylistic preference here. It is the reason the project is structured the way
it is.

## Red → Green → Refactor

1. **Red.** Translate the issue's acceptance criteria into a test. Run it. Read the failure
   message — it should describe the missing behaviour, not a `ReferenceError` from a typo.
2. **Green.** The simplest implementation that passes. Not the best one. The simplest.
3. **Refactor.** Improve the design with the tests green. This is where quality is added;
   skipping it is how "simplest thing that passes" becomes technical debt.

Commit at each transition where it helps a reviewer follow the reasoning.

## Where code goes

| If it... | It belongs in |
|---|---|
| is a pure function over plain data | `packages/core` |
| touches PouchDB or CouchDB | `packages/data` |
| renders or handles user input | `packages/web` |
| serves HTTP or talks to Google | `packages/api` |

**`packages/core` must never import a DOM type, a network client, or a database.** If a
piece of logic seems to need one to be tested, it is nearly always two pieces of logic
tangled together: a pure decision and an impure action. Separate them, put the decision in
`core`, and test the decision exhaustively.

## Testing

| Layer | Tool | Coverage gate |
|---|---|---|
| `core` | Vitest, node environment | **90%** |
| `data` | Vitest + `pouchdb-adapter-memory` | 70% |
| `web` | Vitest browser mode + `@open-wc/testing-helpers` | 70% |
| `api` | Vitest + Fastify `.inject()` | 70% |
| end-to-end | Playwright | not gated |

Prefer testing behaviour through public interfaces. A test that reaches into internals will
break during the refactor step, which defeats the purpose of having it.

### Test naming

Describe the behaviour and the condition, not the function:

```ts
// yes
it('rejects a payload whose Base38 length does not match the declared chunk size')

// no
it('tests decodeBase38')
```

## Issues and branches

- Every change starts from an issue. Issues carry acceptance criteria as Given/When/Then.
- Branch as `<issue-number>-<short-slug>`, e.g. `42-base38-decoder`.
- PRs use `Closes #42` and must be green in CI to merge.
- Labels: `type:*`, `area:*`, `size:*`. Milestones M0–M9.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/). Scope is the package:

```
feat(core): decode Base38 chunks into byte buffers
fix(data): merge remark arrays instead of discarding the losing revision
test(core): add spec vectors for the 21-digit manual pairing code
docs(adr): record database-per-project decision
```

## Internationalisation

**Never write a user-visible string literal in a component.** Wrap it in `msg()` from
`@lit/localize` from the first line, even before German translations exist. Retrofitting
i18n across a built UI is miserable work that is never quite finished, and it costs nothing
to do it as you go.

```ts
import { msg } from '@lit/localize'

render() {
  return html`<sl-button>${msg('Add device')}</sl-button>`
}
```

## Handling Matter payloads

Setup passcodes are secrets. Within the codebase:

- **Never log a payload or a passcode**, at any level, including during debugging. Log the
  device id instead.
- Never send a payload to a third-party service. The DCL lookup sends *Vendor ID and
  Product ID only* — never the full payload.
- Do not add analytics or error reporting that could capture document contents.

## Definition of done

- [ ] Test was observed failing before the implementation existed
- [ ] All tests green, coverage gates met
- [ ] `npm run verify` clean
- [ ] User-visible strings wrapped in `msg()`
- [ ] Acceptance criteria in the issue are each demonstrably met
- [ ] Docs or ADR updated if the change alters an architectural decision
