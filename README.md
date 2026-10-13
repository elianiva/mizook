# Mizook

A Telegram assistant on Cloudflare Workers. One chat that never ends: it remembers everything
you say, and nothing needs resetting.

- **Memory** — [`@mizook/memory`](packages/memory): the whole chat is logged word for word and
  compressed into a binary tree of one-line summaries. Each turn sees a constant-size view of it
  and zooms where it needs more. See the [package README](packages/memory/README.md).
- **Agent** — [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable):
  every turn is a durable run. Model calls and tool calls are committed to the Durable Object's
  SQLite before anything is shown, so a restart picks the turn up where it stopped.
- **Telegram** — [Chat SDK](https://chat-sdk.dev) with the Telegram adapter.
- **Deploy** — [Alchemy](https://alchemy.run), declared in `alchemy.run.ts`.
- Everything is [Effect](https://effect.website): services, layers, typed errors.

```
Telegram ─webhook─▶ Worker (src/worker.ts)            checks the secret, then
                       │
                       ▼
                    ChatAgent Durable Object (src/chat-agent.ts)       one chat = one object
                       ├─ Bot      Chat SDK ⇄ Telegram
                       ├─ Agent    one pi-durable conversation per turn
                       ├─ Memory   log, tree, view, compactions         (packages/memory)
                       └─ SQLite   pi-durable + memory + bot state, one connection
```

## Setup

```sh
vp install
cp .env.example .env     # then fill it in
```

| Variable                    | Required | What                                                                   |
| --------------------------- | -------- | ---------------------------------------------------------------------- |
| `BOT_TOKEN`                 | yes      | Telegram bot token from @BotFather                                     |
| `MIZOOK_WEBHOOK_SECRET`     | yes      | Any random string; Telegram sends it back with every update            |
| `OPENCODE_API_KEY`          | yes      | [OpenCode Go](https://opencode.ai/go) key                              |
| `TELEGRAM_ALLOWED_USER_IDS` | yes      | Comma-separated Telegram user ids. Nobody else gets an answer          |
| `MODEL`                     | no       | The agent's model (default `mimo-v2.5-pro`)                            |
| `SUMMARY_MODEL`             | no       | The cheap model that writes the memory (default `claude-haiku-5-5`)    |
| `MODEL_PROVIDER`            | no       | pi-ai provider id (default `opencode-go`)                              |
| `AGENT_NAME`                | no       | What the agent calls itself (default `Mizook`)                         |
| `INSTRUCTIONS`              | no       | Who you are and how you want work done: goes last in the system prompt |
| `TIMEZONE`                  | no       | IANA zone for the dates the agent sees (default `Asia/Jakarta`)        |

Message the bot before you know your id: it answers a stranger with their Telegram id.

## Deploy

Alchemy needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (or a profile: `alchemy profile`).

```sh
vp run deploy            # alchemy deploy: Worker + ChatAgent Durable Object
vp run webhook https://<the url deploy printed>
```

`vp run dev` runs the same stack under `alchemy dev`. `vp run destroy` tears it down.

## Develop

```sh
vp check     # format, lint, types
vp test      # the memory package's tests and the Telegram chunker
```
