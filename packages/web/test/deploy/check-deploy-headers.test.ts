import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const checker = join(repoRoot, 'scripts/check-deploy-headers.mjs')

/**
 * Runs the caching-contract check over a throwaway `_headers`.
 *
 * The same shape as the i18n checker's test, and for the same reason: a checker nobody has
 * watched fail is a checker nobody knows works. Each case below plants exactly one thing and
 * asserts the verdict flips — including a positive control, so a checker that failed
 * everything would not read as thorough (lesson L3).
 */
function scan(headers: string): { code: number; output: string } {
  const directory = mkdtempSync(join(tmpdir(), 'check-deploy-headers-test-'))
  try {
    writeFileSync(join(directory, '_headers'), headers)
    const result = spawnSync('node', [checker, '--scan', directory], { encoding: 'utf8' })
    return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** A contract that satisfies every rule. Each case below breaks exactly one thing in it. */
const GOOD = `
/assets/*
  Cache-Control: public, max-age=31536000, immutable

/index.html
  Cache-Control: no-cache

/
  Cache-Control: no-cache

/sw.js
  Cache-Control: no-cache

/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'
`

describe('the deployment caching contract', () => {
  it('accepts a contract that revalidates the shell and pins the fingerprinted assets', () => {
    const { code, output } = scan(GOOD)
    expect(output).toContain('ok')
    expect(code).toBe(0)
  })

  it('accepts the contract this repository actually deploys', () => {
    // The positive control that matters: every case below proves the checker can say no, and
    // this one proves the file it guards says yes. Run without --scan, against the real thing.
    const result = spawnSync('node', [checker], { encoding: 'utf8' })
    expect(`${result.stdout}${result.stderr}`).toContain('ok')
    expect(result.status).toBe(0)
  })

  it('catches a service worker that browsers would cache', () => {
    // The failure the issue names: a cached service worker cannot be replaced by a new one,
    // so it serves an old bundle indefinitely and nothing anywhere looks wrong.
    const { code, output } = scan(
      GOOD.replace('/sw.js\n  Cache-Control: no-cache', '/sw.js\n  Cache-Control: max-age=86400'),
    )
    expect(code).toBe(1)
    expect(output).toContain('/sw.js')
  })

  it('catches a broad rule that pins the shell along with everything else', () => {
    // The realistic way this gets broken later: someone adds one generous rule for
    // performance, and it silently swallows index.html and sw.js.
    const { code, output } = scan(`${GOOD}\n/*\n  Cache-Control: public, max-age=604800\n`)
    expect(code).toBe(1)
    expect(output).toContain('/*')
  })

  it('catches a broad rule that pins the shell even when it is written first', () => {
    // Same bug as above, arriving from the other side. A checker that only looked at the last
    // matching rule would pass this — and there is no last-one-wins to appeal to: Cloudflare
    // joins duplicate headers with a comma, so the shell ends up with both.
    const { code, output } = scan(`/*\n  Cache-Control: public, max-age=604800\n${GOOD}`)
    expect(code).toBe(1)
    expect(output).toContain('/*')
  })

  it('catches a shell marked immutable, whatever else the rule says', () => {
    // `immutable` is the one directive that cannot be walked back: it tells the client not to
    // revalidate even when the user presses reload. Paired with `must-revalidate` it looks
    // careful and is not.
    const { code, output } = scan(
      GOOD.replace(
        '/sw.js\n  Cache-Control: no-cache',
        '/sw.js\n  Cache-Control: public, max-age=0, must-revalidate, immutable',
      ),
    )
    expect(code).toBe(1)
    expect(output).toContain('/sw.js')
  })

  it('resolves a :placeholder rule the way Cloudflare does', () => {
    // `:file` spans one path segment, so this rule reaches `/sw.js` — which is not obvious
    // from reading it, and is the sort of rule added to cache "all the js" without noticing
    // that the service worker is js too.
    const { code, output } = scan(
      `${GOOD}\n/:file.js\n  Cache-Control: max-age=31536000, immutable\n`,
    )
    expect(code).toBe(1)
    expect(output).toContain('/:file.js')
  })

  it('catches fingerprinted assets pinned for an hour rather than a year', () => {
    // `immutable` with a short lifetime is the worst of both: the client still comes back, and
    // when it does it refuses to revalidate. It reads as a considered choice.
    const { code, output } = scan(GOOD.replace('max-age=31536000', 'max-age=3600'))
    expect(code).toBe(1)
    expect(output).toContain('/assets/')
  })

  it('catches a shell with no cache rule at all', () => {
    // Unstated is not safe. Without a rule the browser and the CDN each apply a heuristic,
    // and the two do not have to agree.
    const { code, output } = scan(GOOD.replace('/index.html\n  Cache-Control: no-cache\n', ''))
    expect(code).toBe(1)
    expect(output).toContain('/index.html')
  })

  it('catches fingerprinted assets left to revalidate on every request', () => {
    // The other half of the contract. These URLs cannot change contents, so re-fetching them
    // is pure cost - paid on the connection least able to afford it.
    const { code, output } = scan(GOOD.replace('public, max-age=31536000, immutable', 'no-cache'))
    expect(code).toBe(1)
    expect(output).toContain('/assets/')
  })

  it('refuses a Cache-Control it cannot parse rather than assuming it is fine', () => {
    // The verdict is asserted through the *message*, not the exit code. A checker that fell
    // through and crashed on the unparsed value would also exit non-zero, and "it exited 1"
    // cannot tell a considered refusal apart from a TypeError.
    const { code, output } = scan(GOOD.replace('no-cache', 'no-cache, max-age=surely'))
    expect(code).toBe(1)
    expect(output).toContain('could not be parsed')
    expect(output).toContain('max-age=surely')
  })

  it('refuses a line that is neither a path nor a header', () => {
    const { code, output } = scan(`${GOOD}\nnot-a-path-and-not-a-header\n`)
    expect(code).toBe(1)
    expect(output).toContain('not-a-path-and-not-a-header')
  })

  it('refuses a header written before any path', () => {
    const { code } = scan(`  Cache-Control: no-cache\n${GOOD}`)
    expect(code).toBe(1)
  })

  it('says so when there is no contract to check', () => {
    // An absent file is the same deployment failure as a wrong one, and is easier to reach:
    // moving the file out of `public/` stops it being published with nothing turning red.
    const directory = mkdtempSync(join(tmpdir(), 'check-deploy-headers-test-'))
    try {
      const result = spawnSync('node', [checker, '--scan', directory], { encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(`${result.stdout}${result.stderr}`).toContain('_headers')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reads a comment as a comment', () => {
    const { code } = scan(`# why these rules exist\n${GOOD}`)
    expect(code).toBe(0)
  })
})

describe('the security headers the shell is served with', () => {
  it('catches a shell served with no Content-Security-Policy', () => {
    // The policy was measured against the real bundle in a real browser (todo-47) — which is
    // work nobody is going to repeat, so the result has to be guarded rather than trusted to
    // survive the next edit of this file.
    const { code, output } = scan(GOOD.replace(/\n {2}Content-Security-Policy:.*\n/, '\n'))
    expect(code).toBe(1)
    expect(output).toContain('Content-Security-Policy')
  })

  it('catches a policy that allows inline script', () => {
    // Which is the whole point of having one. A CSP with `'unsafe-inline'` in `script-src`
    // still *looks* like a CSP in a report, and stops nothing an injected `<script>` would do.
    const { code, output } = scan(
      GOOD.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
    )
    expect(code).toBe(1)
    expect(output).toContain('unsafe-inline')
  })

  it('catches a policy that allows eval', () => {
    const { code, output } = scan(
      GOOD.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"),
    )
    expect(code).toBe(1)
    expect(output).toContain('unsafe-eval')
  })

  it('catches a policy that will load script from anywhere', () => {
    const { code, output } = scan(GOOD.replace("script-src 'self'", "script-src 'self' *"))
    expect(code).toBe(1)
    expect(output).toContain('script-src')
  })

  it('catches a policy with no script-src and no default-src to fall back to', () => {
    // `script-src` falls back to `default-src`, and a policy with neither restricts nothing
    // about script at all while still being a valid header.
    const { code, output } = scan(GOOD.replace("default-src 'none'; script-src 'self'; ", ''))
    expect(code).toBe(1)
    expect(output).toContain('script')
  })

  it('catches a policy that can be framed', () => {
    // `frame-ancestors` does not fall back to `default-src`, so leaving it out is the easy
    // mistake — and clickjacking a delete is what it costs.
    const { code, output } = scan(GOOD.replace("; frame-ancestors 'none'", ''))
    expect(code).toBe(1)
    expect(output).toContain('frame-ancestors')
  })

  it('catches a policy that lets an injection rewrite the base URL', () => {
    // `base-uri` does not fall back either. With it unset, one injected `<base>` repoints every
    // relative script URL on the page — `script-src 'self'` and all.
    const { code, output } = scan(GOOD.replace("; base-uri 'none'", ''))
    expect(code).toBe(1)
    expect(output).toContain('base-uri')
  })

  it('catches a shell that may be sniffed', () => {
    const { code, output } = scan(GOOD.replace('  X-Content-Type-Options: nosniff\n', ''))
    expect(code).toBe(1)
    expect(output).toContain('X-Content-Type-Options')
  })

  it('catches a shell that leaks a referrer', () => {
    const { code, output } = scan(GOOD.replace('  Referrer-Policy: no-referrer\n', ''))
    expect(code).toBe(1)
    expect(output).toContain('Referrer-Policy')
  })

  it('accepts a policy that is stricter than required', () => {
    // The check is a floor, not a shape. Tightening `style-src` when the third-party fonts go
    // (see the note in `_headers`) must not fail because it no longer matches a literal.
    const { code } = scan(GOOD.replace("style-src 'self' 'unsafe-inline'", "style-src 'self'"))
    expect(code).toBe(0)
  })
})
