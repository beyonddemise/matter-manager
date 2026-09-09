# The backend image. Referenced by infra/compose.prod.yml since M0, and missing until #120.
#
# Two stages, so the runtime image carries no compiler, no test files and no development
# dependencies. What ships is `node_modules` for production plus the emitted JavaScript.
#
# **Build context is the repository root**, not this directory — `infra/couchdb/design-docs`
# is copied from it below, and `design-docs.ts` finds those by walking up from the installed
# code. See `infra/compose.prod.yml`.
#
# This package installs on its own: nothing here reaches for a workspace root, and no
# dependency lives behind a licensed registry, so the image is buildable by anybody. That is a
# property of the layout rather than of this file — see `backend/README.md`.

# ---- build ------------------------------------------------------------------------------
# Pinned to the same major as .nvmrc. A runtime that differs from the one the tests ran on is
# the kind of difference that shows up only in production.
FROM node:24-bookworm-slim AS build

WORKDIR /app

# The manifests first, so a change to source does not invalidate the dependency layer.
# `.npmrc` carries no credential — it records why peer resolution is relaxed.
COPY backend/package.json backend/package-lock.json backend/.npmrc ./

# `--ignore-scripts` for the same reason as CI: a transitive dependency's postinstall would
# otherwise run with whatever is in this environment.
RUN npm ci --ignore-scripts

COPY backend/tsconfig.json ./
COPY backend/src ./src

# `test/**/*.ts` is in the tsconfig `include` and is deliberately absent here, which is fine:
# a glob matching nothing is only an error when *every* glob does. Emits to `dist/src`,
# because `rootDir` is the package root. Prune the compiler and the rest of the development
# dependencies before node_modules is copied into the runtime.
RUN npx tsc --build \
    && npm prune --omit=dev --ignore-scripts

# ---- runtime ----------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# Not root. The process needs to read its own code and talk to CouchDB, and nothing else.
USER node
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist

# The design documents CouchDB is given at startup. `design-docs.ts` finds them by walking up
# from the installed code looking for `infra/couchdb/design-docs`, so the path relative to
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
CMD ["node", "dist/src/main.js"]
