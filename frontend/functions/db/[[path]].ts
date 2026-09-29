import { forward, type PagesContext } from '../_lib/forward.js'

/**
 * Everything under `/db`, forwarded to CouchDB with the prefix removed.
 *
 * `COUCHDB_URL` names the public hostname rather than a private address, and that is the
 * access control: every request therefore passes through the host Caddy on `wisselroot` and
 * inherits its `@forbidden` blocklist - `_all_dbs`, `_utils`, `_membership`,
 * `_node/_local/_config`, `_cluster_setup`. The list is defined once, in that Caddyfile, and
 * this file deliberately adds no second copy to drift out of step with it.
 *
 * Ships ahead of its consumer: `src/ui/sync/` exists and nothing in the shipped bundle imports
 * it yet. That is in the spec and is deliberate - honouring one of the two prefixes that
 * `devProxy` names would recreate the development/production split the contract exists to
 * prevent.
 */
export const onRequest = (context: PagesContext): Promise<Response> => forward(context, 'db')
