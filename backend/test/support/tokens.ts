import { mintToken, type SigningKey } from '../../src/auth/jwt.js'
import { accessClaims } from '../../src/auth/routes.js'
import type { Plan } from '../../src/domain/index.js'

/**
 * An access token as `POST /auth/token` mints it: the same claims, from the same builder.
 *
 * Built with `accessClaims` rather than a literal, so a claim the route adds or drops is added or
 * dropped here too. A hand-copied set is how the route once omitted `name` while every test
 * presenting this helper's token carried it.
 */
export function accessTokenFor(
  key: SigningKey,
  who: { sub: string; email: string; name?: string },
  now = Math.floor(Date.now() / 1000),
  plan: Plan = 'free',
): string {
  return mintToken(key, accessClaims(who, plan, now))
}
