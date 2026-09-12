# todo-193 — the suppression had never matched anything

Closes #193 by refusing it, and fixes the rule that should have prevented it.

## Symptom

Dependabot offered `devcontainers/typescript-node` `1-24-bookworm` → `5-26-bookworm`, which moves
the devcontainer from Node 24 to Node 26. #173 added an `ignore` rule specifically to stop this,
after #160 offered the same bump.

`scripts/check-node-pins.mjs` failed the run:

```text
::error file=.devcontainer/docker-compose.yml::typescript-node image declares 26,
  but .nvmrc declares 24
```

So the backstop worked exactly as #173's comment promised — "the CI pin check is what makes that
certain rather than assumed". The suppression did not.

## Cause

Two things were wrong, and both had to be, because the rule had never run at all.

**The name carried a registry host.**

```yaml
- dependency-name: mcr.microsoft.com/devcontainers/typescript-node
```

**Dependabot strips the registry.** Its own compatibility-score link on #193 says so:
`dependency-name=devcontainers/typescript-node&package-manager=docker_compose`. The options
reference gives the same rule by example — for
`<account>.dkr.ecr.us-west-2.amazonaws.com/base/foo/bar/ruby:3.1.0-focal-jemalloc`, use
`base/foo/bar/ruby`.

So the entry matched no dependency from the day it was written. **A Dependabot `ignore` that
matches nothing is not an error**: it is read, it matches nothing, and the run succeeds. An inert
suppression and a working one look identical. The only symptom is the pull request it was
supposed to prevent, arriving as though no rule existed — a month later.

The two `matter-manager/couchdb` names beside it have no host, which is why those have always
worked. One entry out of five was wrong, and it was the only one anybody needed to be right.

**And `update-types` rested on an assumption that cannot be checked.** The rule said
`update-types: [version-update:semver-major]`. This tag is `1-24-bookworm`: the leading `1` is the
devcontainer image's own version and `24` is the Node major. **One tag, two independent
versions.** Whether Dependabot classifies `1-24-bookworm → 5-26-bookworm` as `semver-major` is
undocumented for non-semver Docker tags — the options reference covers `x.y.z` and says nothing
about this shape.

## What was done

`- dependency-name: devcontainers/typescript-node`, with no `update-types`.

Dropping `update-types` is the part worth arguing. There is **no** update to this tag that is
safe to take automatically, because a bump of the image's own version can carry a Node major with
it — which is precisely what `5-26-bookworm` is. Ignoring the image outright needs no assumption
about how a non-semver tag is classified.

The cost is real and small: patch updates to the devcontainer image are no longer offered. It is a
development-only image, nothing in it reaches production, and adopting a new tag was already meant
to be a decision somebody makes rather than a pull request that arrives.

## The check, because this class of mistake is silent

`scripts/check-dependabot-ignores.mjs`. In a container ecosystem, a `dependency-name` whose first
path segment contains a dot is a registry host, and the entry is dead. That is the one part of
this file's naming that is machine-checkable — a misspelled package name is still silent — and it
had already cost a month of an unguarded pin.

Parsed with a regex rather than a YAML library on purpose: this runs in `npm run verify` at the
repository root, and the root installs exactly one package. Adding `yaml` to read one field would
give the root a dependency it does not otherwise need.

Three branches, each observed:

| planted | result |
| --- | --- |
| `mcr.microsoft.com/devcontainers/typescript-node` — the real bug | exit 1, naming `devcontainers/typescript-node` as the fix |
| `ghcr.io/beyonddemise/something` | exit 1 — not hard-coded to one registry |
| `dependency-name:` renamed so nothing matches | exit 1, "found no dependency-name entries at all" |

The third matters most: a check that finds nothing must fail, or it becomes the same kind of thing
it was written to catch.

## Verified

- `npm run verify` — exit 0. 5 dependency-name entries checked, 7 Node declarations agree,
  frontend 1516 tests in 86 files, backend 787 in 33.
- `.github/dependabot.yml` and `.github/workflows/ci.yml` both parse.
- #193 itself is closed rather than merged: the update it proposes is the one this policy exists
  to refuse, and `check-node-pins.mjs` rejects it on the merits.

## Not here

The E401 on every Dependabot pull request's Frontend job — `WEBAWESOME_NPM_TOKEN` is present in
the Actions secret store and absent from the Dependabot one, so Dependabot-triggered runs install
with an empty token. That is a settings change, not a code change, and it is why #193's Frontend
job failed alongside the pin check. Raised separately.
