export const CLINE_API_BASE = 'https://api.cline.bot/api/v1'

/** OAuth WorkOS JWTs need their scheme prefix; plan keys stay unchanged. */
export function clineApiToken(token: string): string {
  return /^eyJ[\w-]+\.[\w-]+\./.test(token) ? `workos:${token}` : token
}

export const CLINE_HEADERS = { 'HTTP-Referer': 'https://cline.bot', 'X-Title': 'anticode' }
