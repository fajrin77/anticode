import { createHash, randomBytes } from 'node:crypto'

/** RFC 7636 verifier: 43-128 chars from the unreserved set. */
export function makeVerifier(): string {
  return randomBytes(48).toString('base64url')
}

export function makeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** The random `state` sent with the authorize URL and checked on callback. */
export function makeState(): string {
  return randomBytes(16).toString('hex')
}