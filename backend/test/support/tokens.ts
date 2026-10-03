import { randomUUID } from 'node:crypto'
import { mintToken, type SigningKey } from '../../src/auth/jwt.js'

/** An access token as `POST /auth/token` would mint it. */
export function accessTokenFor(
  key: SigningKey,
  who: { sub: string; email: string; name?: string },
  now = Math.floor(Date.now() / 1000),
): string {
  return mintToken(key, {
    purpose: 'access',
    ...who,
    jti: randomUUID(),
    iat: now,
    exp: now + 300,
    '_couchdb.roles': ['free'],
  })
}
