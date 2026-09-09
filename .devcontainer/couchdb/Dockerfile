# Development CouchDB with configuration baked in.
#
# **Build context is the repository root**, because the shared configuration lives in
# `infra/couchdb/00-base.ini` and is used by this image and the production one alike. See
# `.devcontainer/docker-compose.yml`.
#
# The configuration is COPYed rather than bind-mounted. The upstream entrypoint runs
#
#   find /opt/couchdb \! \( -user couchdb -group couchdb \) -exec chown -f couchdb:couchdb '{}' +
#
# as root under `set -e`. A bind-mounted host file cannot be chowned, so `chown` fails;
# `-f` suppresses the message but not the exit status, `find` returns non-zero, and the
# entrypoint dies with exit code 1 and NO log output whatsoever. Baking the file in with
# --chown avoids the problem entirely and makes the config immutable.
FROM couchdb:3.5.2.1
# Lexical order in local.d/ is the override mechanism: the base first, the overlay second.
COPY --chown=couchdb:couchdb infra/couchdb/00-base.ini /opt/couchdb/etc/local.d/00-base.ini
COPY --chown=couchdb:couchdb .devcontainer/couchdb/10-development.ini /opt/couchdb/etc/local.d/10-development.ini
