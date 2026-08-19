# Development CouchDB with configuration baked in.
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
COPY --chown=couchdb:couchdb couchdb-local.ini /opt/couchdb/etc/local.d/zz-devcontainer.ini
