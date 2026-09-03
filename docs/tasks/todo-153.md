# todo-153 — Dependabot cannot install Web Awesome Pro

Closes #153.

## Symptom

Two failures, three days apart from anyone noticing, both from one missing credential.

**Every Dependabot pull request fails CI** at `Install (no lifecycle scripts)`:

```
WEBAWESOME_NPM_TOKEN:
npm error code E401
```

**`Dependabot Updates` on `main` fails** while resolving one package:

```
| @awesome.me/webawesome-pro | private_source_authentication_failure |
```

## Cause

`WEBAWESOME_NPM_TOKEN` was set once, in the **Actions** secret store. There are two stores, and
a run triggered by Dependabot reads only the other one — the run log says so outright:
`Secret source: Dependabot`. `secrets.WEBAWESOME_NPM_TOKEN` therefore expanded to the empty
string, `.npmrc` interpolated nothing, and the Pro registry refused the request.

That isolation is deliberate and worth keeping: an update to an untrusted dependency must not
be able to reach the credentials the rest of CI holds.

The updater's own failure is the same missing value at a different layer. Resolving a version
range on a private registry is a request Dependabot makes *before* any workflow starts, so it
needs the credential through `registries:` in `.github/dependabot.yml`, which did not exist.

## Which half matters more

The CI failure is loud: three red pull requests. The updater failure is the one to worry about.

It is reported inside a run log that needs write access to read, and Dependabot carries on and
opens pull requests for everything else.

*(Corrected after this landed: an earlier version of this line said the run "looks successful
from the outside". It does not — the conclusion is `failure`, plainly visible in `gh run list`.
What hides it is everything around the mark. A `Dependabot Updates` run is not a pull request
check, so it blocks nothing and notifies nobody; each ecosystem is its own job, so
`github_actions … success` sits in the list beside the failure; and the pull request list, which
is where anyone actually looks, fills up as usual from the ecosystems that worked. See
[todo-156](todo-156.md), the same failure in the docker ecosystem.)* The
observable effect of Web Awesome Pro never being resolvable is that Web Awesome Pro never
appears in an update. Which is indistinguishable from it already being current.

The UI is built entirely on that library. It has never once been offered for update.

## Change

- `.github/dependabot.yml` declares the `webawesome` npm registry and the npm entry references
  it, so the updater can resolve `@awesome.me/*`.
- `README.md` and `CONTRIBUTING.md` state that the token goes in **both** stores, and why they
  are separate.

## The part that is not in this diff

Adding `WEBAWESOME_NPM_TOKEN` to the repository's **Dependabot** secret store is repository
configuration and leaves no trace in the tree. It is the half that actually unblocks CI; the
`registries:` block above is inert without it.

*Settings → Secrets and variables → Dependabot → New repository secret*, same value as the
Actions secret of that name.

## Review

Verified: `.github/dependabot.yml` parses and yields the expected `registries` mapping and the
`registries: [webawesome]` reference on the npm entry; `npm run verify` clean.

Not verified from here, and it cannot be: that the updater authenticates. That needs the secret
above, and the evidence will be the next `Dependabot Updates` run finishing without a
`private_source_authentication_failure` row.
