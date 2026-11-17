# Mizook

A personal assistant in Telegram, on Cloudflare Workers. Every forum topic of your group is its own
chat that never ends: it remembers everything you say there, and nothing needs resetting.

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

## Features

- **Channels:** each forum topic, General topic and DM is one Durable Object with its own memory, schedules and settings. `/channels` lists them; `ask_channel` reads another one, read-only.
- **Schedules:** `once`, `cron` and `watch` (polls a URL, wakes the agent only when it changes), plus `webhook_link` for services that notify you. Capped at 20 turns an hour.
- **Artifacts:** pages and files at `https://mzk.elianiva.com/a/<token>/<name>`, sandboxed. Versions are kept in R2.
- **Web:** `web_search` (Parallel, then Exa; set `SEARCH_PROVIDERS`) and `web_fetch`.
- **Executor:** one `executor` tool over MCP. A call that needs approval shows Approve and Deny buttons in the chat; the press resumes it and the agent sees the result. Use the plain `/mcp` URL (model mode).
- **Files:** attachments are stored; `file_read` reads text files. Images, voice and PDF content are not read yet.
- **Commands:** `/stop /cost /model /instructions /timezone /budget /name /channels /schedules /export`.
- **Portability:** `/export` gives a tar in the design's layout (`main/`, `tree/`, `view.json`) plus `schedules.json`, `settings.json` and artifacts. A nightly backup of every channel goes to R2 (14 kept).

## Setup

```sh
vp install
cp .env.example .env     # then fill it in
```

| Variable                          | Required | What                                                                              |
| --------------------------------- | -------- | --------------------------------------------------------------------------------- |
| `BOT_TOKEN`                       | yes      | Telegram bot token from @BotFather                                                |
| `MIZOOK_WEBHOOK_SECRET`           | yes      | Any random string; Telegram sends it back with every update                       |
| `DEEPSEEK_API_KEY`                | yes      | [DeepSeek](https://platform.deepseek.com) API key                                 |
| `PARALLEL_API_KEY`, `EXA_API_KEY` | no       | Web search keys, tried in `SEARCH_PROVIDERS` order (default `parallel,exa`)       |
| `EXECUTOR_URL`, `EXECUTOR_TOKEN`  | no       | Executor MCP endpoint (`https://mcp.executor.sh/mcp`) and a personal access token |
| `BUDGET_DAILY`                    | no       | Dollars a channel may spend in 24 hours; 0 or unset is no limit                   |
| `TELEGRAM_ALLOWED_USER_IDS`       | yes      | Comma-separated Telegram user ids. Nobody else gets an answer                     |
| `MODEL`                           | no       | The agent's model (default `deepseek-flash`)                                      |
| `SUMMARY_MODEL`                   | no       | The cheap model that writes the memory (default `deepseek-flash`)                 |
| `AGENT_NAME`                      | no       | What the agent calls itself (default `Mizook`)                                    |
| `INSTRUCTIONS`                    | no       | Who you are and how you want work done: goes last in the system prompt            |
| `TIMEZONE`                        | no       | IANA zone for the dates the agent sees (default `Asia/Jakarta`)                   |

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
vp check          # format, lint (Effect rules included)
pnpm typecheck    # tsrs and effect-tsrs
vp test      # the memory package's tests and the Telegram chunker
```

## CI and deploy

`.github/workflows/ci.yml` runs check, typecheck and test on every push. A push to `master` then runs
`alchemy deploy --stage prod`. Set these in the repository's `production` environment:

| Kind      | Names                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets   | `CLOUDFLARE_API_TOKEN`, `BOT_TOKEN`, `MIZOOK_WEBHOOK_SECRET`, `DEEPSEEK_API_KEY`, `PARALLEL_API_KEY`, `EXA_API_KEY`, `EXECUTOR_TOKEN` |
| Variables | `CLOUDFLARE_ACCOUNT_ID`, `TELEGRAM_ALLOWED_USER_IDS`, `EXECUTOR_URL`, `INSTRUCTIONS`, `BUDGET_DAILY`                                  |

Each name may be a secret or a variable; the workflow reads both.

The deploy job points Telegram at the Worker after each deploy. To do it by hand: `vp run webhook https://mzk.elianiva.com`.

## Dashboard

A dashboard lives at `/admin`: status and spend, the chat log, the memory view, usage, and schedules, per channel. It can answer an approval (approve or deny) and cancel a schedule, each after a second click. Writes need the Access token, a same-origin post with an `x-mizook-csrf` header, and are logged in the channel's `app_audit` table. It is a Foldkit app in `apps/dashboard`, styled with Panda, and the Worker serves its build as static assets next to a JSON API at `/admin/api`.

To work on it, run the mock-free path: `pnpm --filter @mizook/dashboard dev` proxies `/admin/api` to `ADMIN_API` (default `http://localhost:8788`). `pnpm deploy` builds it before `alchemy deploy`.

Alchemy declares the Access application and policy (`alchemy.run.ts`), so `alchemy deploy` is the whole setup. Set these first:

- `ACCESS_TEAM_DOMAIN`: your Zero Trust team domain, `<team>.cloudflareaccess.com`.
- `ADMIN_EMAIL`: the one email the policy allows.
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (optional): a GitHub OAuth app whose callback is `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`. Alchemy creates the GitHub login method from it. Without them, Access uses the login methods the account already has.

The application covers `/admin*` only, so `/telegram/webhook`, `/hook`, `/a`, `/d` and `/x` stay outside it. The Worker also checks the Access token itself (RS256, issuer, audience, expiry), and `/admin` answers 503 while the team domain or audience is missing.
