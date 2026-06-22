# Blurt

A Telegram bot that lets you manage your Apple Calendar and Apple Reminders by chatting in plain English. Runs in the cloud so it works even when your Mac is off — events sync to all your Apple devices via iCloud CalDAV.

> *"Schedule a coffee chat tomorrow at 3pm at Blue Bottle for 30 minutes, remind me 15 minutes before"*
>
> → New event appears in Apple Calendar on every device within seconds.

## Features

- **Natural-language scheduling** — talk to it like a person, no forms or commands.
- **Multi-calendar aware** — picks the right calendar from context (gym → Workouts, class → School, meeting → Work).
- **Event alerts** — sets VALARM alarms ("remind me 1 hour before").
- **Recurring items** — "every Monday", "every other week", "daily until June 30" create a single repeating event/reminder (RRULE), not a pile of copies.
- **Locations** — addresses get geocoded by Apple Calendar for directions.
- **Apple Reminders support** — can create/list/complete tasks (with caveats — see [Apple Reminders Limitations](#apple-reminders-limitations)). Blurt auto-detects whether your account actually exposes CalDAV reminder lists and adapts.
- **Rich Telegram replies** — bold titles, priority indicators, and grouped lists via Telegram MarkdownV2 (falls back to plain text if formatting ever fails).
- **Conversation memory** — follow-ups like *"actually move it to 4pm"* just work.
- **Whitelist auth** — only your Telegram chat IDs can use it.

## Architecture

```
Telegram ⇄ Bot (Telegraf, long-polling) ⇄ LLM (tool use) ⇄ iCloud CalDAV
                                                                    │
                                                                    ▼
                                                          Apple Calendar / Reminders
                                                       (syncs to all your devices)
```

- **Long-polling** means no public URL or webhook is needed — the bot just needs outbound internet.
- Runs anywhere Docker runs: Fly.io, a VPS, a Raspberry Pi, etc.

## Prerequisites

| What | Where |
|---|---|
| **Telegram bot token** | [@BotFather](https://t.me/BotFather) → `/newbot` |
| **LLM API key** | [Anthropic](https://console.anthropic.com) (default) or [OpenAI](https://platform.openai.com) — see [Configuration](#configuration) |
| **iCloud app-specific password** | [appleid.apple.com](https://appleid.apple.com) → *Sign-In and Security* → *App-Specific Passwords* |
| **Your IANA timezone** | e.g. `America/Los_Angeles`, `Europe/London`, `Asia/Tokyo` |

> ⚠️ The iCloud password must be an **app-specific password**, not your normal Apple ID password.

## Quick Start (Local)

```bash
git clone <this-repo>
cd blurt
npm install
cp .env.example .env
# Edit .env and fill in your tokens
npm run dev
```

The bot will start polling Telegram. Send any message to your bot — the console will log your Telegram chat ID. Add it to `ALLOWED_CHAT_IDS` in `.env` and restart so only you can use the bot.

## Deploy to Fly.io

Fly is the recommended host. A single small VM (256 MB shared-CPU) is plenty.

```bash
brew install flyctl
fly auth signup   # or `fly auth login`

# Edit fly.toml first — pick a globally-unique app name and your preferred region
fly apps create <your-app-name>

fly secrets set \
  TELEGRAM_BOT_TOKEN='...' \
  ANTHROPIC_API_KEY='...' \
  ICLOUD_USERNAME='you@icloud.com' \
  ICLOUD_APP_PASSWORD='xxxx-xxxx-xxxx-xxxx' \
  USER_TIMEZONE='America/Los_Angeles' \
  ALLOWED_CHAT_IDS=''   # leave empty for the first run

fly deploy
fly logs
```

Send your bot a message in Telegram. Find your chat ID in the logs (`[auth] Open mode — message from chat 123456789`), then lock it down:

```bash
fly secrets set ALLOWED_CHAT_IDS='123456789'
```

Fly will auto-redeploy.

> Fly now requires a payment method on file before creating apps, even for the free tier. The Hobby plan still covers a small always-on machine for free.

## Deploy with Docker (any host)

```bash
docker build -t blurt .
docker run -d --restart unless-stopped --name blurt \
  -e TELEGRAM_BOT_TOKEN='...' \
  -e ANTHROPIC_API_KEY='...' \
  -e ICLOUD_USERNAME='you@icloud.com' \
  -e ICLOUD_APP_PASSWORD='xxxx-xxxx-xxxx-xxxx' \
  -e USER_TIMEZONE='America/Los_Angeles' \
  -e ALLOWED_CHAT_IDS='123456789' \
  blurt
```

Works on Hetzner, DigitalOcean, Oracle Cloud Always Free, a Raspberry Pi at home — anywhere Docker runs.

## Configuration

All configuration is via environment variables (loaded from `.env` locally or set as secrets in production).

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | From @BotFather |
| `LLM_PROVIDER` | optional | Which backend to use: `anthropic` (default) or `openai`. |
| `ANTHROPIC_API_KEY` | if anthropic | From console.anthropic.com |
| `OPENAI_API_KEY` | if openai | From platform.openai.com |
| `OPENAI_BASE_URL` | optional | Point at any OpenAI-compatible endpoint (Groq, Together, OpenRouter, Ollama). |
| `ICLOUD_USERNAME` | yes | Your Apple ID email |
| `ICLOUD_APP_PASSWORD` | yes | App-specific password (NOT your normal Apple ID password) |
| `USER_TIMEZONE` | yes | IANA name, e.g. `America/Los_Angeles` |
| `ALLOWED_CHAT_IDS` | recommended | Comma-separated Telegram chat IDs allowed to use the bot |
| `ICLOUD_CALENDAR_NAME` | optional | Default calendar for new events. Defaults to first writable. |
| `ICLOUD_REMINDER_LIST_NAME` | optional | Default reminder list. Defaults to first. |
| `MAX_HISTORY_MESSAGES` | optional | Conversation history cap per chat. Default `20`. |
| `LLM_MODEL` | optional | Model id for the active provider. Defaults: `claude-sonnet-4-6` (anthropic) / `gpt-4o` (openai). Cheaper/faster: `claude-haiku-4-5` or `gpt-4o-mini` (recommended for personal use). |

## LLM Providers

Blurt's reasoning runs on a pluggable LLM backend. `LLM_PROVIDER` selects which one; it defaults to `anthropic`. The backend is resolved once at startup and reused for the life of the process.

### Choosing a provider

| | `anthropic` (default) | `openai` |
|---|---|---|
| **API used** | Messages API | Chat Completions API |
| **Default model** | `claude-sonnet-4-6` | `gpt-4o` |
| **Cheaper option** | `claude-haiku-4-5` | `gpt-4o-mini` |
| **Required key** | `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` |
| **Custom endpoint** | — | `OPENAI_BASE_URL` (Groq, Together, OpenRouter, Ollama, Azure OpenAI, …) |
| **Tool-error fidelity** | full — per-tool `is_error` flag is passed through | the error *text* is preserved, but there is no `is_error` field in Chat Completions, so that boolean flag is dropped (the model still sees the error in the tool result) |

Both providers drive the same tool-use loop and the same calendar/reminder tools — the only behavioral difference is the tool-error fidelity noted above. For personal use the cheaper models (`claude-haiku-4-5` / `gpt-4o-mini`) are usually more than adequate; override with `LLM_MODEL`.

The OpenAI adapter deliberately targets **Chat Completions** (not the Responses API) so any OpenAI-compatible endpoint works by setting `OPENAI_BASE_URL` — point it at a local Ollama, Groq, OpenRouter, etc. without code changes.

### Adding another backend

A provider is just an implementation of the `LLMProvider` interface in `src/providers/types.ts` (translate the neutral message/tool shapes to and from the SDK, and declare which HTTP errors are retryable). Register it in `getProvider()` in `src/providers/index.ts`. Nothing else in the agent or tool layer needs to change.

### What happens when keys are missing or invalid

- **Unknown `LLM_PROVIDER`** — startup fails fast with `Unknown LLM_PROVIDER "<value>". Supported values: anthropic, openai.` (a typo never silently falls back to a default). This is checked both at launch (`src/index.ts`) and in `getProvider()`.
- **Missing required key** — `index.ts` validates the key matching the selected provider (`ANTHROPIC_API_KEY` for `anthropic`, `OPENAI_API_KEY` for `openai`) at startup and exits with a clear message before the bot connects to Telegram. The *other* provider's key can be left blank.
- **Invalid / revoked key (auth fails at request time)** — the model call returns HTTP 401/403. Blurt does **not** retry auth failures; it replies in the chat with `Auth failed talking to the model API — check your provider API key.`
- **Provider overloaded / rate-limited** — transient errors are retried automatically with exponential backoff (`1s → 2s → 4s → 8s → 15s` + jitter, up to 6 attempts), on top of each SDK's own `maxRetries: 2`. The retryable status codes are per-provider — Anthropic: 529/503/502/500; OpenAI: 429/500/503. If it's still failing after retries, the user gets a "model API is overloaded / rate limited, try again" message instead of a crash.

> There is **no automatic cross-provider failover** — if your selected provider is down, Blurt surfaces the error rather than silently switching backends and changing model behavior mid-conversation. To switch, change `LLM_PROVIDER` (and the matching key) and restart.

## Telegram Commands

- `/start` — welcome message
- `/clear` — reset conversation history for the current chat
- Anything else — Blurt routes it through calendar / reminder tools

## Example Conversations

```
You: What's on my calendar today?
Bot: You have 2 events today:
     • 10:00 AM – 10:30 AM  Daily standup  (Work)
     • 4:00 PM – 5:00 PM    Leg day        (Workouts) — alarm 15 min before
```

```
You: Schedule lunch with mom Sunday at 1pm at Sushi Zanmai Shibuya, remind me an hour before
Bot: Added lunch with mom to Personal — Sun May 24, 1:00 PM–2:00 PM at Sushi Zanmai Shibuya
     with a 1-hour alert. ✅
```

```
You: Move my dentist appointment to 11am
Bot: Moved "Dentist" to 11:00 AM – 12:00 PM on Friday.
```

```
You: Remind me to text the landlord at 8pm
Bot: Set a calendar event "Text the landlord" at 8:00 PM with an alarm at start. ✅
```

## Project Structure

```
src/
├── index.ts                 # Entry: env validation + bot launch
├── bot.ts                   # Telegraf setup, auth, history, commands
├── agent.ts                 # Provider-agnostic agentic tool-use loop with backoff
├── telegram-format.ts       # Markdown → Telegram MarkdownV2 (with escaping)
├── providers/               # LLM seam: neutral types + Anthropic & OpenAI adapters
└── tools/
    ├── definitions.ts       # Tool JSON schemas (provider-neutral)
    ├── dispatcher.ts        # Routes tool name → implementation
    ├── caldav.ts            # CalDAV client + capability/list discovery (cached)
    ├── handle.ts            # Opaque base64url UID handles
    ├── rrule.ts             # Recurrence (RRULE) build/parse helpers
    ├── calendar.ts          # VEVENT operations (events)
    └── reminders.ts         # VTODO operations (reminders / tasks)

test/
├── unit/                    # Pure-logic tests, no network (node:test)
└── integration/             # Live CalDAV round-trip — gated on iCloud creds
```

## Testing

Tests use Node's built-in test runner (`node:test`) executed through `tsx`, so there's no extra test framework to install.

```bash
npm test               # unit tests — fast, no network or credentials needed
npm run test:integration   # live iCloud CalDAV round-trip (needs credentials, see below)
npm run typecheck      # tsc --noEmit (also part of "done")
```

- **Unit tests** (`test/unit/`) cover the pure logic: opaque-handle encoding, history pruning invariants, the provider message/stop-reason translation for both Anthropic and OpenAI, ICS build/parse (timed, all-day, alarms, RRULE), recurrence build/parse, partial-failure detection, and the Telegram MarkdownV2 escaper. They run offline and require no API keys.
- **Integration tests** (`test/integration/`) exercise the real create → list → update → delete lifecycle (and RRULE round-trip) against iCloud CalDAV. They **skip automatically** unless `ICLOUD_USERNAME` and `ICLOUD_APP_PASSWORD` are set, so `npm test` stays green on a fresh checkout. They clean up every event they create.

  ```bash
  ICLOUD_USERNAME='you@icloud.com' \
  ICLOUD_APP_PASSWORD='xxxx-xxxx-xxxx-xxxx' \
  USER_TIMEZONE='America/Los_Angeles' \
  npm run test:integration
  ```

## How It Works

1. You send a Telegram message.
2. The bot forwards it to the configured LLM with the calendar/reminder tools registered.
3. The model inspects the message, chooses tool(s), and calls them.
4. Tools talk to iCloud CalDAV (`caldav.icloud.com`), which is the same backend Apple Calendar and Reminders use.
5. iCloud propagates the change to every signed-in device via push within seconds.
6. The model composes a friendly confirmation and sends it back to you on Telegram.

## Apple Reminders Limitations

iCloud has two parallel reminder systems:

- **Legacy CalDAV reminders** — what this bot writes to.
- **Modern CloudKit Reminders** — what the iOS/macOS Reminders app reads from on newer accounts.

If your account was migrated to the new format (most accounts post-iOS 13), reminders the bot creates may not appear in the Reminders app. They will appear in the CalDAV `Reminders` list — sometimes visible via iCloud.com → Reminders.

**Workaround:** By default, Blurt treats `"remind me to X at <time>"` requests as **calendar events with alarms** instead of true reminders. This sidesteps the limitation and gets you the same notification-on-your-device behavior. To force a true reminder, say *"add a task to Reminders"* explicitly.

## Security Notes

- The `ALLOWED_CHAT_IDS` whitelist is the only thing preventing strangers from using your bot's calendar access if they discover the bot's username. **Set it.**
- Never commit `.env`. The included `.gitignore` excludes it.
- Use Fly secrets / Docker env vars for production — they're encrypted at rest.
- The iCloud app-specific password can be revoked at any time at appleid.apple.com.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

- Calendar access via the [tsdav](https://github.com/natelindev/tsdav) CalDAV client
- iCal generation/parsing via [ical.js](https://github.com/kewisch/ical.js)
- Timezone math via [Luxon](https://moment.github.io/luxon/)
- Telegram framework: [Telegraf](https://telegraf.js.org/)
