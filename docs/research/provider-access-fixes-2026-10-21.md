# Provider access and login fixes — 21 October 2026, 0.0.61

## Findings from the configured accounts

OpenRouter had seven unique saved keys. Each accepted a small streaming request for
`meta/muse-spark-1.3` and `z-ai/glm-5.3-flashx` (14 HTTP 200 responses). At 32 output tokens,
most requests ended at `length` before an answer; those are acceptance probes, not successful
answers. A follow-up with one key per model, 512 tokens and low reasoning effort returned
text with `finish_reason: stop` for both. These are direct API diagnostics, not coding benchmarks
or proof that all keys can handle a long coding context.

Prior conversation errors included `Prompt tokens limit exceeded: 79985 > 9785` and
`79997 > 33060`. Anticode incorrectly treated their HTTP 402 status as exhausted account
usage and parked each key for 15 minutes. These request-size limits do not establish that all
accounts have exhausted their quota. The `/key` responses had null credit caps and reported
free-request counters separately; neither proves unlimited allowance. Seven keys may share
an account and its limits. The tested model IDs do not have a `:free` suffix and are not
reclassified as free by this change.

The custom provider named OpenCode Free was configured with `/zen/go/v1`. Adding Anticode's
own user agent and stable session header removed the missing-session error, but that endpoint
returned HTTP 403 requiring an active Go subscription. A separate read-only probe with the
same key at `/zen/v1` returned HTTP 403 restricting Free to OpenCode's own application.
A free model name, login or refreshed key does not override this provider restriction.
No endpoint was silently rewritten, no paid fallback was enabled and no official-client
identity was impersonated.

## Changes

- Separate input-size, affordable output and in-flight-credit errors from exhausted balance.
  Try another key on the same endpoint/model without imposing a quota cooldown for those
  request-specific errors. Retain all existing genuine quota/authentication cooldown rules.
- When all tried keys reject the input size, make one local digest of older replay context
  and retry the same selected provider. Keep the current prompt/tool sequence and saved full
  transcript. If the system/tool payload itself cannot fit or the retry fails, stop clearly.
  Partial streamed answers are never replayed.
- Send `x-opencode-session` for custom OpenCode providers as well as the native Go adapter,
  including compaction requests. Explain Go-plan and official-Free access denials separately.
- Add Auth provider entries for OpenRouter Free (browser PKCE), Kilo Free (browser device
  authorization), and MiniMax Token Plan (portal plus `sk-cp` plan key). Free connections
  filter live account catalogues and reject paid aliases before sending credentials.
  MiniMax validates the plan endpoint and accepts only explicitly supported plan model IDs.
  Existing custom providers, keys, endpoint choices and Composer visibility are preserved.

This is not implementation of every provider displayed by 9Router. OpenCode Go's documented
public connection uses a Console plan key. OpenCode Free cannot currently be asserted usable
from Anticode. New Kilo/OpenRouter browser flows and MiniMax plan connection were tested with
fixtures; no new real user login/plan subscription was claimed.

## Verification

- TypeScript checks and production build passed. Packaged 0.0.61 boots, opens a chat
  and renders Settings without startup errors using an empty isolated profile.
- 600 unit tests passed across 59 files.
- `scripts/verify-free-auth.mjs`: real Electron UI/IPC, fixture callback/device approval,
  masked MiniMax key input, sealed storage and free/plan catalogue filtering passed.
- `scripts/verify-provider-keyring.mjs`: actual adapter/IPC fixture exercises two keys,
  model grouping, secure storage and restart persistence.
- Unit fixtures cover bounded context recovery and preserved transcript, no request-size
  cooldown, malformed catalogue retention, paid-alias rejection, OpenCode custom session
  metadata and product-denial explanations. Fixtures do not prove provider entitlement.

## Primary sources

- [OpenRouter OAuth PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth)
- [OpenRouter limits](https://openrouter.ai/docs/api_reference/limits)
- [OpenRouter model catalogue](https://openrouter.ai/api/v1/models)
- [Kilo official device authentication source](https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-gateway/src/auth/device.ts)
- [Kilo authentication response types](https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-gateway/src/types.ts)
- [OpenCode Go connection and session requirements](https://opencode.ai/v2/docs/console/go/)
- [MiniMax Token Plan](https://platform.minimax.io/subscribe/token-plan)
