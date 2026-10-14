# Development CouchDB with configuration baked in.
#
# **Build context is this directory** (see `.devcontainer/docker-compose.yml`). The base
# configuration `00-base.ini` is this repository's copy of the one the backend repository
# (matter-manager-backend) owns and ships to production — the droplet stack moved there, and
# with it the production image, so this file and the backend's must be kept in agreement.
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
COPY --chown=couchdb:couchdb 00-base.ini 10-development.ini /opt/couchdb/etc/local.d/
