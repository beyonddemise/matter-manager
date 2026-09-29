import { forward, type PagesContext } from '../_lib/forward.js'

/**
 * Everything under `/api`, forwarded to the API with the prefix removed.
 *
 * `[[path]]` is Cloudflare's catch-all: it matches `/api` itself and every path beneath it.
 * A single `functions/[[path]].ts` at the root would have been fewer files and would have
 * intercepted every request on the site, including every static asset - making `_routes.json`
 * load-bearing for correctness rather than merely explicit.
 */
export const onRequest = (context: PagesContext): Promise<Response> => forward(context, 'api')
