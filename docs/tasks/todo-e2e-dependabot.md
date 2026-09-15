# The third directory nobody was watching

No issue: this is a defect introduced by #192 and found while answering "what needs to be changed
for dependabot".

## Symptom

`.github/dependabot.yml` watched `/`, `/frontend` and `/backend`. The repository has **four**
npm lockfiles. `/e2e` got one in #192, when `e2e` stopped being a root workspace and became a
self-contained directory — and was never added here.

So `@playwright/test` was watched by nothing. Of all the packages to lose, that is the pointed
one: it is the package that has to stay in step with `frontend`'s `playwright`, whose divergence
to 1.63.0 against 1.62.1 broke CI in #186. The `dev-tooling` group carries `group-by:
dependency-name` specifically to hold those two together — and grouping cannot hold two things in
step when one of them is not being watched at all.

## The pattern, for the third time

| | listed | actually there | unwatched |
| --- | --- | --- | --- |
| #156 | `docker: /infra` | `/infra/couchdb/Dockerfile` | three base images, since the repository was created |
| #179 | `npm: /` | `/backend/package-lock.json` after #164 | nine dependencies, Fastify and pino among them, **security advisories included** |
| here | `npm: /, /frontend, /backend` | `/e2e/package-lock.json` after #192 | `@playwright/test` |

Each was found weeks later by something else failing. **Dependabot does not recurse**, and a
directory it was never told about produces no error — the run succeeds and the thing simply goes
unwatched.

L36 names this pattern, and #181 wrote `/frontend` into the config in the same change that created
the directory, explicitly so the lesson would not need relearning. Then #192 created a directory
and did not. Knowing the pattern was not enough; the config and the tree drift apart whenever a
human has to remember to keep them together.

## What was done

`/e2e` added — and the check that makes a fourth instance impossible.

`scripts/check-dependabot-ignores.mjs` becomes `scripts/check-dependabot.mjs`, because it now
answers one question rather than two halves of an unrelated pair: **is this configuration
correct?** It reads the files on disk with `git ls-files` and fails when a directory holding a
manifest is not listed for the ecosystem that would update it:

- `npm` — every `package-lock.json`
- `docker` — every `Dockerfile`
- `docker-compose` — every compose file

`github-actions` is deliberately not checked. Workflows only live in `.github/workflows`, so
`directory: /` covers them by definition and there is nothing a scan could disagree with.

**The parser fails loudly when it does not understand the file.** That is the price of hand-parsing
YAML rather than adding `yaml` to a root that installs exactly one package. Every expected
ecosystem must yield at least one directory, each must match at least one file, and the name scan
must yield at least one entry — otherwise it exits saying it can no longer read the file. A hand
parser that silently found nothing would be exactly the bug it exists to catch.

## Also here

`frontend`'s `playwright` was `^1.62.1` while `e2e`'s `@playwright/test` was `^1.63.0`. Both
resolved to 1.63.0, so nothing was broken — but the declared floors disagreed for no reason, and
these two are the pair whose drift broke CI once already. Both are `^1.63.0` now.

## Verified

Each branch observed failing, then restored and re-run clean:

| planted | result |
| --- | --- |
| `/e2e` absent — the real defect | `` `npm` does not watch /e2e, which holds a file it would update `` |
| `package-ecosystem: docker-compose` renamed | `no package-ecosystem: docker-compose entry at all - either it was removed, or this check can no longer read the file` |
| `directories: []` | `` `npm` lists no directories, so it watches nothing `` |
| registry host put back on a name | the #194 message, naming the fix — so that half still works after the refactor |

`npm run verify` — exit 0. 14 checks over `dependabot.yml`, frontend 1516 tests in 86 files,
backend 787 in 33.

## Still not fixed by this

Nothing here touches the credential. `WEBAWESOME_NPM_TOKEN` has been granted to this repository as
an organisation secret; whether Dependabot-triggered runs can now read it is answered by the next
Dependabot pull request's `Frontend` job, not by anything in this change.
