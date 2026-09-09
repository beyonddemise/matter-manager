# Production CouchDB with configuration baked in.
#
# **Build context is the repository root**: `00-base.ini` is shared with the development image,
# so neither can be built from its own directory. See `infra/compose.prod.yml`.
#
# See .devcontainer/couchdb/Dockerfile for why this is COPYed and not bind-mounted.
FROM couchdb:3.5.2.1
# Lexical order in local.d/ is the override mechanism: the base first, the overlay second.
COPY --chown=couchdb:couchdb infra/couchdb/00-base.ini /opt/couchdb/etc/local.d/00-base.ini
COPY --chown=couchdb:couchdb infra/couchdb/10-production.ini /opt/couchdb/etc/local.d/10-production.ini
