# todo-161 — Dependabot resolving images this repository builds itself

Closes #161. Follow-up to #156, from the first `Dependabot Updates` run after #157 merged —
the run that pull request said it would go and read.

## What the run answered

Both open questions from todo-156 got answers within the hour, and they went opposite ways.

**The docker fix works.** `docker in /.devcontainer/couchdb, /infra/couchdb, /packages/api`
succeeded for the first time since the repository was created, and immediately opened #158
bumping the Node base image in `packages/api/Dockerfile`. That update had been available and
unoffered the whole time — which is the concrete form of what #156 was about.

**`compose.prod.yml` is recognised**, despite not being one of the four default compose
filenames. The errors below are the proof: they name an image that only appears in that file.

## The new failure

`docker_compose in /.devcontainer, /infra` failed:

```text
Remote response: {"errors":[{"code":"UNAUTHORIZED","message":"authentication required",
  "detail":[{"Type":"repository","Name":"matter-manager/couchdb","Action":"pull"}]}]}
Handled error whilst updating matter-manager/couchdb:
  private_source_authentication_failure {source: "registry.hub.docker.com"}
```

`matter-manager/couchdb` and `matter-manager/couchdb-dev` each sit beside a `build:` block in
the same compose file. They are names for images this repository *produces*, published to no
registry anywhere. Dependabot resolves every `image:` it finds against Docker Hub regardless,
is refused, and fails.

Not a total loss — #160 was still raised for the devcontainer's `typescript-node` — but the run
is red, and `caddy:2-alpine` is on the far side of the error.

## Change

`ignore:` entries for the two names on the `docker-compose` update. An `image:` next to a
`build:` is output, not input.

## The error string is a false friend

`private_source_authentication_failure` is exactly what #153 reported for Web Awesome Pro, and
the two have nothing in common. There, a credential existed and was in the wrong secret store;
the fix was to put it in both. Here there is nothing to authenticate *to* — the image is not
published. Reading the second occurrence as another instance of the first would have sent the
fix in entirely the wrong direction.

## Verification

The configuration parses to the expected shape. Note that GitHub's
`.github/dependabot.yml` validator check, which did run on #157 and passed there, **did not run
on this pull request** — so unlike #157, the keys here are documented rather than validated. It
appears inconsistently and is not something to rely on.

Whether it silences the failure is a claim about the next run, not about this diff, and that run
is the evidence. What to look for: `docker_compose in /.devcontainer, /infra` concluding
`success`, and `caddy:2-alpine` being reached rather than sitting behind an error — it may
simply be current, in which case the absence of a pull request means nothing on its own and the
log is what to read.
