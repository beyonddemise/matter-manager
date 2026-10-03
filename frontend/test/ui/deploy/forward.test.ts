import { describe, expect, it } from 'vitest'
import {
  forward,
  prefixFor,
  stripPrefix,
  targets,
  toResponse,
  upstreamHeaders,
  upstreamUrl,
} from '../../../functions/_lib/forward.js'
import { devProxy } from '../../../vite.config.js'

/**
 * The production forwarder, tested the way `dev-proxy.test.ts` tests its counterpart: by
 * handing the module an environment rather than letting it read one. The reason is the same
 * and is worth repeating — a test that reads the machine's own `.env` passes for its author
 * and fails for everybody else.
 */

describe('where each prefix points', () => {
  it('covers the same two prefixes the development proxy does', () => {
    expect(Object.keys(targets({})).sort()).toEqual(['/api', '/db'])
  })

  it('reads API_ORIGIN for /api and COUCHDB_URL for /db', () => {
    const env = { API_ORIGIN: 'https://api.example', COUCHDB_URL: 'https://db.example' }
    expect(targets(env)['/api'].origin).toBe('https://api.example')
    expect(targets(env)['/db'].origin).toBe('https://db.example')
  })

  it('names the variable that aims it, so a 502 can say which one is missing', () => {
    expect(targets({})['/api'].variable).toBe('API_ORIGIN')
    expect(targets({})['/db'].variable).toBe('COUCHDB_URL')
  })

  it('treats a variable that is present but empty as absent', () => {
    // A dashboard field saved blank, or a deployment tool rendering an unset value, produces
    // an empty string rather than an absent key. `composition.ts` and `devProxy` both make
    // this same equation; a forwarder that did not would fetch `/auth/google` with no origin.
    expect(targets({ API_ORIGIN: '' })['/api'].origin).toBe('')
    expect(targets({ API_ORIGIN: '   ' })['/api'].origin).toBe('')
  })

  it('maps each upstream to its prefix', () => {
    expect(prefixFor('api')).toBe('/api')
    expect(prefixFor('db')).toBe('/db')
  })
})

describe('stripping the prefix', () => {
  it('removes it, because the API serves its routes at the root', () => {
    expect(stripPrefix('/api/projects', '/api')).toBe('/projects')
    expect(stripPrefix('/db/project_local', '/db')).toBe('/project_local')
  })

  it('strips only the leading prefix', () => {
    // `/api/things/api-key` contains the word twice, and only the first is the mount point.
    expect(stripPrefix('/api/things/api-key', '/api')).toBe('/things/api-key')
  })

  it('leaves the empty string for the bare prefix, exactly as Vite does', () => {
    // Turning it into `/` is `upstreamUrl`'s job, deliberately: this function has a counterpart
    // in vite.config.ts and the parity test below compares them character for character. A
    // normalisation applied here and not there would be a real divergence reported as a
    // passing test.
    expect(stripPrefix('/api', '/api')).toBe('')
    expect(stripPrefix('/db', '/db')).toBe('')
  })
})

describe('parity with the development proxy', () => {
  // Development and production are two implementations of one contract. Nothing but this
  // assertion stops them drifting, and a drift is invisible in both places: each works.
  //
  // What this pins is narrower than "the two sides agree": it compares only the *rewrite*
  // functions — what stripping a prefix leaves — never the *matching* rule that decides whether
  // a path reaches a rewrite at all. The two matching rules genuinely differ: Vite's proxy key
  // '/api' is an unanchored prefix match, so `/apikey` is proxied in development and rewritten
  // to `/key`; `_routes.json`'s `include: ["/api/*"]` is anchored at the slash, so `/apikey`
  // never reaches a Function in production and falls through to the single-page app instead.
  // Nothing below can see that difference, and nothing has to today — `/apikey` is not a route
  // on either side, so no production path collides with it.
  it('agrees on which prefixes exist', () => {
    expect(Object.keys(targets({})).sort()).toEqual(Object.keys(devProxy({})).sort())
  })

  it('agrees on what stripping a prefix leaves', () => {
    const paths = ['/api', '/api/', '/api/projects', '/api/things/api-key', '/api/auth/google']
    for (const path of paths) {
      expect(stripPrefix(path, '/api')).toBe(devProxy({})['/api'].rewrite(path))
    }
    for (const path of ['/db', '/db/', '/db/project_local', '/db/_changes']) {
      expect(stripPrefix(path, '/db')).toBe(devProxy({})['/db'].rewrite(path))
    }
  })
})

describe('the URL actually fetched', () => {
  it('joins the origin, the stripped path and the query', () => {
    expect(upstreamUrl('https://api.example', '/projects', '?limit=10')).toBe(
      'https://api.example/projects?limit=10',
    )
  })

  it('trims a trailing slash from the origin', () => {
    // COUCHDB_URL is set on the live project *with* a trailing slash. Concatenating gives
    // `https://couch.matter-manager.io//project_local`, and an empty first path segment is a
    // different route to CouchDB, not a cosmetic difference. The literal below is the deployed
    // value, not a tidied one, because a tidied one would leave this untested.
    expect(upstreamUrl('https://couch.matter-manager.io/', '/project_local', '')).toBe(
      'https://couch.matter-manager.io/project_local',
    )
  })

  it('trims however many slashes there are', () => {
    expect(upstreamUrl('https://db.example///', '/x', '')).toBe('https://db.example/x')
  })

  it('turns the bare prefix into the root', () => {
    // `stripPrefix('/db', '/db')` is '', and `https://db.example?x` is not the root with a
    // query - it is a URL whose path is empty, which CouchDB and the API both read differently
    // from `/`.
    expect(upstreamUrl('https://db.example', '', '')).toBe('https://db.example/')
    expect(upstreamUrl('https://db.example', '', '?a=1')).toBe('https://db.example/?a=1')
  })

  it('keeps the query string', () => {
    // Replication is `_changes?since=…&feed=longpoll&heartbeat=…`. A forwarder that rebuilt
    // the URL from the pathname alone would serve /api/healthz perfectly and break every
    // replication request, which is the sort of bug that gets diagnosed as "CouchDB is slow".
    expect(
      upstreamUrl('https://db.example', '/project_local/_changes', '?feed=longpoll&since=42'),
    ).toBe('https://db.example/project_local/_changes?feed=longpoll&since=42')
  })

  it('does not re-encode what the browser already encoded', () => {
    // The pathname arrives percent-encoded from `new URL(request.url).pathname`. Running it
    // through URL construction again would double-encode a document id containing a space or
    // a slash, and PouchDB document ids routinely contain both.
    expect(upstreamUrl('https://db.example', '/project_local/a%20b%2Fc', '')).toBe(
      'https://db.example/project_local/a%20b%2Fc',
    )
  })
})

/** A request as it arrives at the edge, with whatever headers the test needs. */
function incoming(url: string, headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request(url, { method, headers })
}

describe('the headers sent upstream', () => {
  it('forwards the handoff cookie to the API', () => {
    const headers = upstreamHeaders(
      incoming('https://app.matter-manager.io/api/projects', { cookie: 'mm_handoff=abc' }),
      'api',
    )
    expect(headers.get('cookie')).toBe('mm_handoff=abc')
  })

  it('strips the cookie on the way to CouchDB', () => {
    // The handoff cookie is Path=/, so the browser attaches it to every /db/* request without
    // being asked. CouchDB has no use for it - replication authenticates with the bearer JWT -
    // so forwarding it ships a sign-in credential to a different service, and into its logs,
    // on every replication request. Nothing about that failure is visible: it works.
    const headers = upstreamHeaders(
      incoming('https://app.matter-manager.io/db/project_local', { cookie: 'mm_handoff=abc' }),
      'db',
    )
    expect(headers.get('cookie')).toBeNull()
  })

  it('forwards Authorization to both', () => {
    for (const kind of ['api', 'db'] as const) {
      const headers = upstreamHeaders(
        incoming('https://app.matter-manager.io/x', { authorization: 'Bearer token' }),
        kind,
      )
      expect(headers.get('authorization')).toBe('Bearer token')
    }
  })

  it('sets X-Forwarded-For from CF-Connecting-IP', () => {
    const headers = upstreamHeaders(
      incoming('https://app.matter-manager.io/api/x', { 'cf-connecting-ip': '203.0.113.9' }),
      'api',
    )
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.9')
  })

  it('overwrites a caller-supplied X-Forwarded-For rather than appending to it', () => {
    // The API runs with TRUST_PROXY=true and Fastify reads the *leftmost* entry as the client
    // address. Appending would leave the caller's own value leftmost, letting them choose
    // their rate-limit bucket. compose.prod.yml states the consequence of getting this family
    // of settings wrong: "the first twenty sign-in attempts from anywhere lock out everybody
    // else."
    const headers = upstreamHeaders(
      incoming('https://app.matter-manager.io/api/x', {
        'x-forwarded-for': '10.0.0.1',
        'cf-connecting-ip': '203.0.113.9',
      }),
      'api',
    )
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.9')
  })

  it('removes a caller-supplied X-Forwarded-For when the edge gave us no address', () => {
    // Keeping it would be worse than having none: it is attacker-chosen and would be trusted.
    const headers = upstreamHeaders(
      incoming('https://app.matter-manager.io/api/x', { 'x-forwarded-for': '10.0.0.1' }),
      'api',
    )
    expect(headers.get('x-forwarded-for')).toBeNull()
  })

  it('states the protocol and the host the browser used', () => {
    const headers = upstreamHeaders(incoming('https://app.matter-manager.io/api/x'), 'api')
    expect(headers.get('x-forwarded-proto')).toBe('https')
    expect(headers.get('x-forwarded-host')).toBe('app.matter-manager.io')
  })

  it('drops hop-by-hop headers', () => {
    // They describe this connection, not the message. Forwarding `Connection: keep-alive` or a
    // `Transfer-Encoding` to a different connection is a protocol error that some servers
    // tolerate and some do not.
    const headers = upstreamHeaders(
      incoming('https://app.matter-manager.io/api/x', {
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
        upgrade: 'websocket',
      }),
      'api',
    )
    for (const name of ['connection', 'keep-alive', 'upgrade']) {
      expect(headers.get(name)).toBeNull()
    }
  })

  it('drops the headers that Connection names, not just Connection itself', () => {
    // `Connection: X-Custom` says X-Custom belongs to this connection alone. Deleting
    // Connection and forwarding X-Custom is the half of the rule that is easy to miss, because
    // nothing breaks - the field just travels one hop further than its sender allowed.
    const headers = upstreamHeaders(
      incoming('https://app.matter-manager.io/api/x', {
        connection: 'X-Custom, X-Another',
        'x-custom': 'one',
        'x-another': 'two',
      }),
      'api',
    )
    expect(headers.get('connection')).toBeNull()
    expect(headers.get('x-custom')).toBeNull()
    expect(headers.get('x-another')).toBeNull()
  })

  it('does not carry the browser-facing Host upstream', () => {
    // fetch() derives Host from the URL it is given, which is what `changeOrigin: true` does
    // in the dev proxy. An explicit Host left over from the inbound request would contradict
    // it, and Caddy routes on Host - so the request would arrive at the wrong site block.
    const headers = upstreamHeaders(incoming('https://app.matter-manager.io/api/x'), 'api')
    expect(headers.get('host')).toBeNull()
  })
})

describe('the response handed back to the browser', () => {
  it('keeps the status and the status text', () => {
    const out = toResponse(new Response('no', { status: 403, statusText: 'Forbidden' }))
    expect(out.status).toBe(403)
    expect(out.statusText).toBe('Forbidden')
  })

  it('keeps a redirect as a redirect rather than following it', () => {
    // Step 3 of the sign-in flow. If this became a 200 the browser would be shown Google's
    // authorization page served from our origin, never navigated anywhere, and never given a
    // cookie - a failure that presents as a broken page, not as an error.
    const out = toResponse(
      new Response(null, {
        status: 302,
        headers: { location: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' },
      }),
    )
    expect(out.status).toBe(302)
    expect(out.headers.get('location')).toBe('https://accounts.google.com/o/oauth2/v2/auth?x=1')
  })

  it('keeps both Set-Cookie headers when the upstream sets two', () => {
    // `clearCookies` sets two in one reply. Copying headers one key at a time through a plain
    // object keeps the last and loses the first, leaving a cookie the user believed they had
    // cleared - which is why this is `new Response(body, upstream)` and not a hand-copied map.
    const upstream = new Response(null, { status: 204 })
    upstream.headers.append('set-cookie', 'mm_handoff=; Max-Age=0; Path=/')
    upstream.headers.append('set-cookie', 'mm_flow=; Max-Age=0; Path=/')
    expect(toResponse(upstream).headers.getSetCookie()).toEqual([
      'mm_handoff=; Max-Age=0; Path=/',
      'mm_flow=; Max-Age=0; Path=/',
    ])
  })

  it('passes a 304 through without inventing a body', () => {
    // PouchDB leans on conditional requests, and the Response constructor *throws* if a
    // null-body status is given a body. A forwarder that always passed `upstream.body` would
    // work until the first cache revalidation and then 500.
    const out = toResponse(new Response(null, { status: 304, headers: { etag: '"1-abc"' } }))
    expect(out.status).toBe(304)
    expect(out.headers.get('etag')).toBe('"1-abc"')
  })

  it('passes a 204 through', () => {
    expect(toResponse(new Response(null, { status: 204 })).status).toBe(204)
  })

  it('drops hop-by-hop headers on the way back too', () => {
    const upstream = new Response('ok', { status: 200, headers: { connection: 'close' } })
    expect(toResponse(upstream).headers.get('connection')).toBeNull()
  })

  it('drops the headers that Connection names on the way back too', () => {
    // Same rule, the other direction. An upstream that names a field in Connection means it
    // for the hop it is on, not for the browser.
    const upstream = new Response('ok', {
      status: 200,
      headers: { connection: 'X-Upstream-Only', 'x-upstream-only': 'leaked' },
    })
    const out = toResponse(upstream)
    expect(out.headers.get('connection')).toBeNull()
    expect(out.headers.get('x-upstream-only')).toBeNull()
  })

  it('preserves the body', async () => {
    expect(await toResponse(new Response('{"ok":true}', { status: 200 })).text()).toBe(
      '{"ok":true}',
    )
  })

  it('adds no CORS headers to the response', () => {
    // Every request through this Function is same-origin by construction, so an
    // Access-Control-Allow-Origin here would describe a flow that does not exist and would be
    // the first thing to mislead somebody debugging a future one. This is anchored on
    // `toResponse`'s output rather than on the request `upstreamHeaders` builds — the earlier
    // version of this test asserted a *response* header was absent from a *request*, which no
    // browser ever sends and no code path here could add, so it could not fail no matter what
    // changed. A future edit that started adding CORS headers to the response is what this
    // guards against.
    const out = toResponse(new Response('ok', { status: 200 }))
    expect(out.headers.get('access-control-allow-origin')).toBeNull()
  })
})

/** Records what `forward` asked for, and answers with whatever the test supplies. */
function recordingFetch(reply: Response | (() => never)) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit })
    if (typeof reply === 'function') reply()
    return reply
  }) as unknown as typeof fetch
  return { impl, calls }
}

const LIVE = {
  API_ORIGIN: 'https://api.matter-manager.io',
  COUCHDB_URL: 'https://couch.matter-manager.io/',
}

describe('forwarding a request', () => {
  it('sends /api/auth/google to the API with the prefix removed', async () => {
    const { impl, calls } = recordingFetch(new Response(null, { status: 302 }))
    await forward(
      { request: incoming('https://app.matter-manager.io/api/auth/google'), env: LIVE },
      'api',
      impl,
    )
    expect(calls[0]?.url).toBe('https://api.matter-manager.io/auth/google')
  })

  it('sends /db to CouchDB with the configured trailing slash collapsed', async () => {
    const { impl, calls } = recordingFetch(new Response('{}', { status: 200 }))
    await forward(
      { request: incoming('https://app.matter-manager.io/db/project_local'), env: LIVE },
      'db',
      impl,
    )
    expect(calls[0]?.url).toBe('https://couch.matter-manager.io/project_local')
  })

  it('strips the cookie on the real /db path, not just in the upstreamHeaders helper', async () => {
    // The spec's failure-modes table calls this the one row with no natural symptom: a cookie
    // forwarded to CouchDB is a silent credential leak with no symptom at all. The unit test on
    // `upstreamHeaders` above calls it directly with a literal `'db'` and proves the stripping
    // rule is right; it says nothing about the wiring that decides which literal `forward`
    // actually passes. This is the guard for that wiring — swap `kind` for a hardcoded `'api'`
    // on the call inside `forward` and every other test in this file still passes.
    const { impl, calls } = recordingFetch(new Response('{}', { status: 200 }))
    await forward(
      {
        request: incoming('https://app.matter-manager.io/db/project_local', {
          cookie: 'mm_handoff=abc',
        }),
        env: LIVE,
      },
      'db',
      impl,
    )
    expect((calls[0]?.init.headers as Headers | undefined)?.get('cookie')).toBeNull()
  })

  it('forwards the cookie on the real /api path', async () => {
    // The mirror image of the test above. Without it, a regression that stripped the cookie
    // from both kinds — not only from /db — would pass that test and still be wrong: the same
    // two-sided-assertion discipline `upstreamHeaders`'s own tests already apply one level down.
    const { impl, calls } = recordingFetch(new Response('{}', { status: 200 }))
    await forward(
      {
        request: incoming('https://app.matter-manager.io/api/projects', {
          cookie: 'mm_handoff=abc',
        }),
        env: LIVE,
      },
      'api',
      impl,
    )
    expect((calls[0]?.init.headers as Headers | undefined)?.get('cookie')).toBe('mm_handoff=abc')
  })

  it('hands the request body straight to the upstream, unbuffered', async () => {
    // The spec: "Bodies pass as streams in both directions. _changes and _bulk_docs are not
    // buffered." Asserting identity rather than content is the point — a forwarder that did
    // `body: await request.text()` would pass a content assertion and fail this one, because
    // reading the body first is exactly the buffering the spec rules out. Two shipped features
    // depend on this today: creating a project (projects.ts) and saving the locale preference
    // (profile.ts) both POST/PUT a JSON body through /api.
    const { impl, calls } = recordingFetch(new Response(null, { status: 201 }))
    const request = new Request('https://app.matter-manager.io/api/projects', {
      method: 'POST',
      body: '{"name":"Kitchen"}',
    })
    await forward({ request, env: LIVE }, 'api', impl)
    expect(calls[0]?.init.body).toBe(request.body)
  })

  it('never follows a redirect', async () => {
    // The default is `follow`. A Function that followed step 3 of the sign-in flow would fetch
    // Google's authorization page server-side and hand *that* back - a 200 of Google's HTML,
    // served from app.matter-manager.io, with the user never redirected and no cookie
    // anywhere. It fails as a broken page rather than as an error, which is why it is pinned.
    const { impl, calls } = recordingFetch(new Response(null, { status: 302 }))
    await forward(
      { request: incoming('https://app.matter-manager.io/api/auth/google'), env: LIVE },
      'api',
      impl,
    )
    expect(calls[0]?.init.redirect).toBe('manual')
  })

  it('answers 502 naming the variable when a target is not configured', async () => {
    const { impl, calls } = recordingFetch(new Response('unreachable'))
    const response = await forward(
      { request: incoming('https://app.matter-manager.io/api/healthz'), env: {} },
      'api',
      impl,
    )
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('API_ORIGIN')
    // It must not have guessed a URL: `fetch('undefined/auth/google')` produces an error
    // somewhere else entirely, about a hostname nobody configured.
    expect(calls).toHaveLength(0)
  })

  it('names COUCHDB_URL when that is the missing one', async () => {
    const { impl } = recordingFetch(new Response('unreachable'))
    const response = await forward(
      { request: incoming('https://app.matter-manager.io/db/x'), env: { API_ORIGIN: 'https://a' } },
      'db',
      impl,
    )
    expect(await response.text()).toContain('COUCHDB_URL')
  })

  it('answers a plain-text 502, so the smoke test can tell a Function ran', async () => {
    // deploy.yml asserts that /api/healthz is not text/html. That assertion passes on a 502
    // deliberately - a 502 from our own Function proves a Function answered at all, which is
    // the single fact that was false before this change existed.
    const { impl } = recordingFetch(new Response('unreachable'))
    const response = await forward(
      { request: incoming('https://app.matter-manager.io/api/healthz'), env: {} },
      'api',
      impl,
    )
    expect(response.headers.get('content-type')).toMatch(/^text\/plain/)
  })

  it('answers 502 without disclosing the upstream when it cannot be reached', async () => {
    const { impl } = recordingFetch(() => {
      throw new TypeError('connection refused')
    })
    const response = await forward(
      { request: incoming('https://app.matter-manager.io/api/healthz'), env: LIVE },
      'api',
      impl,
    )
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('api.matter-manager.io')
  })

  it('passes the upstream reply straight back', async () => {
    const { impl } = recordingFetch(new Response('{"status":"ok"}', { status: 200 }))
    const response = await forward(
      { request: incoming('https://app.matter-manager.io/api/healthz'), env: LIVE },
      'api',
      impl,
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{"status":"ok"}')
  })

  it('forwards the method', async () => {
    const { impl, calls } = recordingFetch(new Response(null, { status: 200 }))
    await forward(
      {
        request: incoming('https://app.matter-manager.io/db/project_local/doc', {}, 'HEAD'),
        env: LIVE,
      },
      'db',
      impl,
    )
    expect(calls[0]?.init.method).toBe('HEAD')
  })
})
