# Claude login and free connections — 21 October 2026

## Implemented

Claude Sign in accepts the complete `code#state`, a bare code, or a callback URL.
Callback URLs are parsed before their fragment. A supplied state must match the current
PKCE attempt; an old code or a code from 9Router must not be reused. Exchange and refresh
use `https://api.anthropic.com/v1/oauth/token` with a 15-second request timeout. Account
and organization UUIDs survive refresh for account deduplication. Tokens remain sealed
by OS secure storage, and code inputs are masked. The login IPC now returns its latest
state so a synchronous paste-code prompt cannot be overwritten by “Starting…”.

OAuth inference identifies itself as Anticode and includes the OAuth beta header.
It does not copy 9Router's CLI impersonation headers or tool-cloaking behavior. Login
success is separate from inference entitlement; Claude remains billing `unknown` and
is not silently treated as free or as included Pro/Max usage.

Settings → Providers → Add provider offers OpenCode Free, OpenRouter Free, and Kilo
Gateway Free presets. Endpoint and free-route policy are persisted and checked during
add, edit, catalogue filtering, and provider creation (including stale session model ids).
OpenCode uses an explicit list of documented Chat Completions free routes. Responses
and SystemOne routes are not assumed to use the same protocol. OpenRouter/Kilo retain
`:free` route ids; only OpenRouter additionally permits `openrouter/free`. Paid aliases
are rejected before inference. Keys use existing encrypted multi-key storage. Kilo additionally supports explicit anonymous
access without an Authorization header. Rejected keys never fall back to anonymous mode.

## Evidence and limits

- REA skill: `/Users/asani/Downloads/rea-main 2/.agents/skills/reverse-engineer-anything/SKILL.md`.
- Installed 9Router 0.5.81 shipped chunks were submitted to REA 6.7.0. Analysis was
  interrupted by a macOS process-ownership helper compilation error: SwiftBridging
  module redefinition. Partial static evidence is not a successful complete REA run.
- Ordinary source inspection of 9Router 0.5.104 supplemented that partial evidence.
  The installed artifact and newer source reference are distinct. Hashes are recorded
  in the adjacent JSON file. No 9Router credential store was imported.
- Typecheck/build and 581 unit tests passed at this stage. Electron fixture verification
  `scripts/verify-claude-auth.mjs` covers actual login UI, IPC, PKCE exchange, sealed tokens,
  preset UI, free catalogue filtering and rejecting edits to paid models. The existing
  native-subscription fixture also passed. These are not live model/coding benchmarks.
- A separate live preview profile was opened for the user's chosen new browser login.
  Browser authorization succeeded and the sealed login survived restarting the preview.
  The installed running app has not been replaced and its sessions have not been stopped.
  This account belongs to the separate preview profile, not the installed app profile.
- Other OAuth and free-tier cards in the screenshots are not all implemented. In
  particular, catalogue entries or browser login alone do not prove an adapter can
  perform streaming, tool replay, vision, refresh, or subscription billing correctly.
- The public OpenCode catalogue query returned `deepseek-v4.1-flash-free`; its observed
  Muse entries were ordinary model ids. No free Muse Contributor entitlement is claimed.

## Sources checked

- [Claude account login and third-party use](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account).
- [Claude Code authentication](https://code.claude.com/docs/en/authentication).
- [OpenCode model routes and free pricing](https://opencode.ai/v2/docs/console/models/).
- [Kilo authentication and anonymous free access](https://kilo.ai/docs/gateway/authentication).
- [Kilo models](https://kilo.ai/docs/gateway/models-and-providers).
- [OpenRouter free router](https://openrouter.ai/openrouter/free/apps).

## Live Claude account checks

The account profile reported active Pro, Stripe subscription billing, and Extra usage off.
Usage reported real 5-hour and 7-day windows. Anticode now reads these windows in Auth
settings instead of inventing a monthly token allowance. Every OAuth inference preflight
requires an active supported subscription and explicit Extra usage off; failure stops
before the messages endpoint. These are profile facts, not third-party billing entitlement,
so Claude remains billing `unknown` and is excluded from automatic subscription-only routing.

The account model catalogue returned 14 routes including `claude-sonnet-5-5`,
`claude-opus-5-5`, and `claude-haiku-5-5`. Anticode now fetches paginated account models,
persists the last complete catalogue, and retains it offline. The three latest routes
were enabled in the isolated preview. Its saved account remained readable after restart.

A standard Anthropic SDK probe with Anticode identity attempted a small fixture tool
round trip. Sonnet 5.5 rejected forced tool choice (400), so the probe was corrected to
automatic tool choice, as used by Anticode. Sonnet 5.5 and Haiku 5.5 then returned 429
without reset headers; no successful answer or coding benchmark is claimed. Missing reset
headers no longer cause Anticode to invent a plan restriction or promise another model
will work. Anthropic's official documentation reserves third-party billing against usage
credits; an active Pro profile cannot establish that Anticode inference uses plan limits.

A live Kilo anonymous probe through the actual OpenAICompatibleProvider adapter passed
streaming, `read_file`, fixture tool replay, and a final answer on
`minimax/minimax-m3.1-flash:free` (two requests). This is a tool round trip, not a coding
benchmark or proof of every Kilo model. An anonymous OpenCode DeepSeek free probe returned
403 restricting free use to official OpenCode clients. No client impersonation was used.

## Local package

Build 0.0.60 passed typecheck/build, 581 unit tests, the Claude/free-policy Electron
fixture (including anonymous Kilo configuration), and the native-subscription fixture.
The packaged app passed the empty-profile smoke test: startup, new chat, Settings,
and no startup errors. Local package: `release/mac-arm64/anticode.app`. The installed
app was not replaced. The active preview uses its own profile; its login is not
automatically imported into the installed app. No publication or deployment was made.

## Installation follow-up — 21 October 2026

At the user's request, 0.0.60 was installed in `/Applications/anticode.app` after the
user quit the main app. The previous bundle and full main profile were backed up.
The installed ASAR hash matches the verified local package. The app reopened and
its local overview returned HTTP 200 with all three sessions, seven sealed accounts,
and the default provider ready. The separate Claude preview account was not imported
into the main profile; updating the app does not merge those profiles.
