# Production CouchDB with configuration baked in.
# See .devcontainer/couchdb/Dockerfile for why this is COPYed and not bind-mounted.
FROM couchdb:3.5.2.1
COPY --chown=couchdb:couchdb local.ini /opt/couchdb/etc/local.d/zz-production.ini
