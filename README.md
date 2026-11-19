# anticode

**Don't pay, just vibes.**

**anticode is a free, open-source desktop AI coding agent (macOS and Windows) that runs on the
subscriptions and API keys you already have, and rotates across them automatically.** Sign in
with your ChatGPT (Codex) and Claude plans, add API keys from OpenRouter, Kilo, Vercel AI
Gateway, MiniMax, OpenCode, Cline, Ollama, or any OpenAI-compatible endpoint, and anticode
spreads each prompt across all of those accounts. No anticode account, no middleman server,
no extra API bill.

[Download the latest release](https://github.com/fajrin77/anticode/releases/latest) | MIT license | Electron + React + TypeScript

## Why anticode

| | What you get |
|---|---|
| **Use your subscription plans** | Log in with ChatGPT (Codex) and Claude through **Auth provider**. Requests spend the quota of the plan you already pay for, not a separate API balance. |
| **Rotate many subscription accounts** | Add several accounts per service. **Rotate usage** picks an eligible account for every new prompt based on how busy it is and how much it has used. |
| **Rotate many API keys per provider** | Store multiple keys per provider (**Edit -> Add API keys**). Keys share one model list and are rotated the same way, alongside free tiers from other providers. |
| **No silent paid fallback** | **Subscription routing** keeps automatic routing inside subscription and free sources. anticode never switches to a paid API behind your back. |
| **Light on your machine** | Models run at the provider, so no local GPU, model download, or VRAM is needed. The app is a single desktop window plus a small menu bar helper. |
| **Simple interface** | One dashboard, two modes (*antichat* for questions, *anticode* for a project folder), one composer. Per-account quota and reset times are visible at a glance. |
| **Private by design** | Direct connection from your device to each provider. Credentials are encrypted in OS secure storage (Keychain / DPAPI) and never written to disk in plain text. |

Subscription access follows each provider's own terms. anticode does not promise unlimited usage.

## Download

Get the latest build from [Releases](https://github.com/fajrin77/anticode/releases/latest):

| System | File | Notes |
|---|---|---|
| macOS (Apple Silicon) | `anticode-<version>-arm64.dmg` | Open, then drag anticode to Applications |
| macOS (Apple Silicon, zip) | `anticode-<version>-arm64-mac.zip` | Alternative without mounting the dmg |
| Windows (64-bit) | `anticode Setup <version>.exe` | NSIS installer |

Each release also ships `latest-mac.yml` and `latest.yml`, which the built-in updater reads.
Installed apps find and install new builds from **Settings -> Updates**.

## Features

- **Multi-provider**: Codex (ChatGPT plan), Claude plan, Cline Free and ClinePass, OpenCode Go / Go Plus, CodeBuddy, OpenRouter, Kilo, Vercel AI Gateway, MiniMax plan, Ollama, and any OpenAI-compatible endpoint.
- **Account and key rotation**: many accounts per subscription service and many keys per API provider, pooled and rotated per prompt.
- **Usage you can see**: provider-reported quota windows (5-hour, weekly, monthly where available) and reset times, a live routing map, and local token and cost history kept separate from subscription quota.
- **Full agent toolset**: files, terminal, web search, Playwright browser, screenshots, sub-agents, MCP servers, image generation, Excel, Word, and PDF.
- **Risk-based approval**: Default mode asks before actions that change things; Auto mode runs without asking.
- **Control from your phone**: open, steer, and approve sessions from a phone browser on the same network.
- **Daily comfort**: automatic context compaction, checklists, checkpoints and Revert, menu bar quick capture, notifications, and automatic updates.

## How rotation works

1. Connect accounts in **Settings -> Auth provider** (subscriptions) or **Settings -> Providers** (API keys).
2. Turn on the sources you want with the **Composer** switch, then pick models in **Settings -> Models**.
3. Accounts of the same service share one model list. For each new prompt anticode chooses an
   available account, weighing current load and local usage records.
4. With **Subscription routing** on, automatic routing stays within subscription and free sources.

Notes:

- The models you can use follow each account's access; signing in does not guarantee every model.
- Several keys from the same provider account do not create separate quota.
- For OpenCode Go / Go Plus, turn off Extra usage in OpenCode Console so plan limits do not spill into PAYG balance.
- Provider integration rules for contributors: [docs/SUBSCRIPTIONS.md](docs/SUBSCRIPTIONS.md).

## FAQ

**Is anticode free?**
Yes. The app is free and MIT licensed. You pay only for the provider plans you already have, or nothing when you use free tiers.

**Can I use my ChatGPT Plus/Pro or Claude Pro/Max subscription for coding instead of API credits?**
Yes. Sign in through Auth provider and anticode uses that plan's quota directly, within the provider's terms.

**Can I rotate several accounts or API keys to stretch limits?**
Yes. Add multiple accounts per subscription service and multiple keys per API provider; anticode rotates them per prompt and shows each account's remaining quota.

**Does it need a GPU or run models locally?**
No GPU is needed. Inference happens at the provider. Local models are optional through Ollama.

**Will it charge my API account without asking?**
No. With Subscription routing on, anticode never falls back to a paid route automatically.

**Where are my keys stored?**
Only on your device, encrypted in OS secure storage. There is no anticode server.

**How is it different from Cursor, Claude Code, or Codex CLI?**
anticode is a provider-agnostic desktop app: one interface for many subscriptions and API providers, with account rotation, usage tracking, and phone control, instead of being tied to one vendor.

## Build from source

```bash
npm install
npm run dev
```

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server + Electron (HMR) |
| `npm test` | Tool, risk policy, and agent loop tests (Vitest) |
| `npm run typecheck` | Typecheck main/preload/shared and renderer |
| `npm run build` | Typecheck, then bundle to `out/` |
| `npm run pack:mac` / `pack:win` / `pack:linux` | Installers via electron-builder into `release/` |

API-key providers can also be configured by copying `.env.example` to `.env`. New profiles have
no built-in provider; connections live in your local profile, never in the repository or update packages.

Global shortcuts: **Cmd/Ctrl+Shift+Space** shows anticode, **Cmd/Ctrl+Alt+Space** opens quick capture.

## Remote (phone)

Enable remote in Settings, then open the shown address in a phone browser on the same network.
Transcript, steering, approvals, and attachments work from the phone and stay in sync with the desktop.

## Security

- Approval follows the mode: Default asks before changes, Auto runs without cards.
- antichat file tools are locked to a private session folder; anticode is locked to the project folder.
- API keys and tokens are encrypted with OS secure storage, never stored in plain text.
- Remote browser access uses a session token and is limited to the local network.

## Releases

See [Releases](https://github.com/fajrin77/anticode/releases) for the latest version and changelog.
