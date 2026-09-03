# The API image. Referenced by infra/compose.prod.yml since M0, and missing until now (#120).
#
# Two stages, so the runtime image carries no compiler, no test files and no development
# dependencies. What ships is `node_modules` for production plus the emitted JavaScript.
#
# **The web workspace is deliberately not installed.** It depends on `@awesome.me/webawesome-pro`,
# which lives behind a licensed registry, so installing it here would mean a build secret in the
# image build for a package the API never imports. Scoping the install to the two workspaces the
# API actually needs keeps the token out of this entirely - and makes the image buildable by
# anybody, licence or not.

# ---- build ------------------------------------------------------------------------------
# Pinned to the same major as .nvmrc. A runtime that differs from the one the tests ran on is
# the kind of difference that shows up only in production.
FROM node:26-bookworm-slim AS build

WORKDIR /app

# The manifests first, so a change to source does not invalidate the dependency layer.
COPY package.json package-lock.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/api/package.json packages/api/

# `--ignore-scripts` for the same reason as CI: a transitive dependency's postinstall would
# otherwise run with whatever is in this environment.
RUN npm ci --ignore-scripts \
      --include-workspace-root \
      --workspace @matter-manager/core \
      --workspace @matter-manager/api

COPY tsconfig.base.json tsconfig.json ./
COPY packages/core packages/core
COPY packages/api packages/api

# `tsc --build` follows the project reference from api to core, so this emits both. Prune the
# compiler and other development dependencies before node_modules is copied into the runtime.
RUN npx tsc --build packages/api \
    && npm prune --omit=dev --ignore-scripts

# ---- runtime ----------------------------------------------------------------------------
FROM node:26-bookworm-slim AS runtime

# Not root. The process needs to read its own code and talk to CouchDB, and nothing else.
USER node
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/core/package.json ./packages/core/package.json
COPY --from=build --chown=node:node /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=node:node /app/packages/api/package.json ./packages/api/package.json
COPY --from=build --chown=node:node /app/packages/api/dist ./packages/api/dist

# The design documents CouchDB is given at startup. `design-docs.ts` finds them by walking up
# from the installed package looking for `infra/couchdb/design-docs`, so the path relative to
# /app is load-bearing rather than tidy. Taken from the build context, not the build stage:
# they are data the compiler never touches.
COPY --chown=node:node infra/couchdb/design-docs ./infra/couchdb/design-docs

EXPOSE 3000

# Its own health, not the platform's. `/healthz` is served even when the service is
# unconfigured, which is the point: a container that is up but serving nothing should look
# different from one that is down.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Directly, not through npm: a shell in front of the process means signals reach the shell and
# not node, and the graceful shutdown in main.ts never runs.
CMD ["node", "packages/api/dist/src/main.js"]
