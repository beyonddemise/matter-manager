/**
 * The translation layer between the API's WebAuthn Level 3 JSON (binary fields as base64url
 * strings) and the browser's `navigator.credentials` API (binary fields as ArrayBuffers).
 *
 * Pure: no fetch, no logging, no DOM beyond the WebAuthn credential types. The `parse*`
 * functions take an API body already parsed from JSON and answer `undefined` for anything that
 * is not the expected shape (an HTML error page, `null`, a missing challenge) — they never throw
 * on a bad body, so the caller has one "no usable options" branch.
 */

/** base64url (RFC 4648 §5, `-`/`_` alphabet, no padding) → bytes. */
export function b64urlToBuffer(value: string): ArrayBuffer {
  // Why: atob wants the standard alphabet and rejects missing padding in some runtimes.
  const standard = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

/** Bytes → base64url, no padding. */
export function bufferToB64url(value: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Request options JSON → what navigator.credentials.get wants ({ publicKey }). undefined when not the shape. */
export function parseRequestOptions(body: unknown): CredentialRequestOptions | undefined {
  if (!isRecord(body) || typeof body.challenge !== 'string') return undefined
  return {
    publicKey: {
      ...(body as object),
      challenge: b64urlToBuffer(body.challenge),
    } as PublicKeyCredentialRequestOptions,
  }
}

/** Creation options JSON → what navigator.credentials.create wants. undefined when not the shape. */
export function parseCreationOptions(body: unknown): CredentialCreationOptions | undefined {
  if (!isRecord(body) || typeof body.challenge !== 'string') return undefined
  if (!isRecord(body.user) || typeof body.user.id !== 'string') return undefined
  const exclude = Array.isArray(body.excludeCredentials) ? body.excludeCredentials : []
  return {
    publicKey: {
      ...(body as object),
      challenge: b64urlToBuffer(body.challenge),
      user: { ...body.user, id: b64urlToBuffer(body.user.id) },
      excludeCredentials: exclude.map((c: Record<string, unknown>) => ({
        ...c,
        id: b64urlToBuffer(String(c.id)),
      })),
    } as PublicKeyCredentialCreationOptions,
  }
}

/** A finished get() ceremony → the completion POST's JSON body. */
export function assertionToJSON(credential: PublicKeyCredential): unknown {
  const response = credential.response as AuthenticatorAssertionResponse
  return {
    id: credential.id,
    type: credential.type,
    rawId: bufferToB64url(credential.rawId),
    response: {
      clientDataJSON: bufferToB64url(response.clientDataJSON),
      authenticatorData: bufferToB64url(response.authenticatorData),
      signature: bufferToB64url(response.signature),
      userHandle: response.userHandle === null ? null : bufferToB64url(response.userHandle),
    },
  }
}

/** A finished create() ceremony → the registration POST's JSON body. */
export function attestationToJSON(credential: PublicKeyCredential): unknown {
  const response = credential.response as AuthenticatorAttestationResponse
  return {
    id: credential.id,
    type: credential.type,
    rawId: bufferToB64url(credential.rawId),
    response: {
      clientDataJSON: bufferToB64url(response.clientDataJSON),
      attestationObject: bufferToB64url(response.attestationObject),
    },
  }
}
