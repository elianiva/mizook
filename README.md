# Mizook

A personal assistant in Telegram, on Cloudflare Workers. It is one or more agents, each a chat that
never ends: an agent remembers everything said to it in every topic it answers in, and nothing needs
resetting.

- **Memory** — [`@mizook/memory`](packages/memory): the whole chat is logged word for word and
  compressed into a binary tree of one-line summaries. Each turn sees a constant-size view of it
  and zooms where it needs more. A full-text index finds exact words when the summary is too
  coarse. See the [package README](packages/memory/README.md).
- **Agent** — [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable):
  every turn is a durable run. Model calls and tool calls are committed to the Durable Object's
  SQLite before anything is shown, so a restart picks the turn up where it stopped.
- **Telegram** — [Chat SDK](https://chat-sdk.dev) with the Telegram adapter.
- **Deploy** — [Alchemy](https://alchemy.run), declared in `alchemy.run.ts`.
- Everything is [Effect](https://effect.website): services, layers, typed errors.

```
Telegram ─webhook─▶ Worker (src/worker.ts)            checks the secret, asks the Hub which agent
                       │                               the place, command or button is for, then
                       ▼
                    AgentObject Durable Object (src/agent-object.ts)       one agent = one object
                       ├─ Bot      Chat SDK ⇄ Telegram
                       ├─ Agent    one pi-durable conversation per turn
                       ├─ Memory   log, tree, view, compactions         (packages/memory)
                       └─ SQLite   pi-durable + memory + bot state, one connection
```

## Features

- **Agents:** each agent is one Durable Object with its own memory and settings. Every topic, group and DM talks to the default agent until `/agent <slug>` binds it to another. `/<slug> …` sends one message to that agent from anywhere, and a reply to a message brings the message along. `/agents` lists them; `ask_agent` reads another one's memory, read-only. `/name` names the place you are in. An agent can have a role (instructions for what it is for), its own persona, a model, and a list of the only tools it gets. Ask an agent to make a new one, such as a fact-checker: `agent_manage` creates, changes or deletes agents after you approve, and the bot menu lists every agent's `/<slug>`.
- **Profile:** a short "about you" and the rules to follow, shared by every agent. `/profile` shows it; the agent updates it when it learns a stable preference.
- **Skills:** reusable procedures the agent saves after a repeatable task and reads by name. An agent's own skills are its alone; global skills live in the Hub and every agent sees them. An agent's own skill wins over a global one of the same name. An automation can name a skill to read when it fires; a pinned skill cannot be deleted while an automation needs it.
- **Standing intents:** "when I mention the launch, remind me about rollback" waits for trigger words in a later message. Matching is a token scan, not a model call; `/intents` lists them.
- **Automations:** a trigger and an action, kept in one `Automations` Durable Object for every agent. Triggers are `once`, `cron`, `watch` (polls a URL, fires only when it changes) and `webhook` (a secret `/hook/<id>/<token>` link other services POST to). Actions are a turn of any agent in any place, a fixed message posted with no model call, or a call to an outside https URL with the trigger's payload in its body. `/automations` lists them and pauses, resumes, tests or cancels one by number; `/runs` shows the last ten and why one failed. Each agent is capped at 20 automation turns an hour.
- **Artifacts:** pages and files at `https://mzk.elianiva.com/a/<token>/<name>`, sandboxed. Versions are kept in R2.
- **Web:** `web_search` (Parallel, then Exa; set `SEARCH_PROVIDERS`) and `web_fetch`. For pages that need JavaScript, `browser_read` renders them with Cloudflare Browser Rendering and returns markdown plus a screenshot link.
- **Executor:** one `executor` tool over MCP. A call that needs approval shows Approve, Always allow and Deny buttons in the chat; the press resumes it and the agent sees the result. `/policies allow|ask|deny <match>` sets standing rules, and an approval expires after 30 minutes. Use the plain `/mcp` URL (model mode).
- **Files:** attachments are stored. Text is read directly, voice notes are transcribed, images are described, and PDF or Office files are converted by Workers AI. `file_read` reads a stored one later.
- **Receipt:** a 👀 reaction means the message reached the bot. Typing starts when the model does, so an eye without typing is a slow model, not a lost message.
- **Commands:** `/stop /cost /model /instructions /timezone /budget /agent /agents /name /profile /skills /intents /policies /automations /runs /export`, plus `/<slug>` for each agent.
- **Portability:** `/export` gives a tar in the design's layout (`main/`, `tree/`, `view.json`) plus `skills.json`, `intents.json`, `policies.json`, `settings.json` and artifacts. A nightly backup of every agent goes to R2 (14 kept).

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
| `BUDGET_DAILY`                    | no       | Dollars an agent may spend in 24 hours; 0 or unset is no limit                    |
| `TELEGRAM_ALLOWED_USER_IDS`       | yes      | Comma-separated Telegram user ids. Nobody else gets an answer                     |
| `MODEL`                           | no       | The agent's model (default `deepseek-flash`)                                      |
| `SUMMARY_MODEL`                   | no       | The cheap model that writes the memory (default `deepseek-flash`)                 |
| `AGENT_NAME`                      | no       | The default agent's name, set when the Hub creates it (default `Mizook`)          |
| `INSTRUCTIONS`                    | no       | Who you are and how you want work done: goes last in the system prompt            |
| `TIMEZONE`                        | no       | IANA zone for the dates the agent sees (default `Asia/Jakarta`)                   |

Message the bot before you know your id: it answers a stranger with their Telegram id.

## Deploy

Alchemy needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (or a profile: `alchemy profile`).

```sh
vp run deploy            # alchemy deploy: Worker + AgentObject Durable Object
vp run webhook https://<the url deploy printed>
```

`vp run dev` runs the same stack under `alchemy dev`. `vp run destroy` tears it down.

## Develop

```sh
vp check          # format, lint and type-check, all on tsrs
pnpm typecheck    # whole-program tsrs check plus effect-tsrs Effect diagnostics
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

A dashboard lives at `/admin`, per agent: an overview (every agent's spend and what waits on you, the running turn, approvals, recent messages, a budget warning), the log, the memory view, usage (per day, model, kind and tool), the automations that act for it, settings, and an audit of what was done from it. It can answer an approval, cancel an automation and stop the running turn, each after a second click, and it edits an agent's model, budget, time zone and instructions through the same code as the slash commands. Writes need the Access token, a same-origin post with an `x-mizook-csrf` header, and are logged in the agent's `app_audit` table. It is a Foldkit app in `apps/dashboard`, styled with Panda, and the Worker serves its build as static assets next to a JSON API at `/admin/api`.

To work on it, run the mock-free path: `pnpm --filter @mizook/dashboard dev` proxies `/admin/api` to `ADMIN_API` (default `http://localhost:8788`). `pnpm deploy` builds it before `alchemy deploy`.

Alchemy declares the Access application and policy (`alchemy.run.ts`), so `alchemy deploy` is the whole setup. Set these first:

- `ACCESS_TEAM_DOMAIN`: your Zero Trust team domain, `<team>.cloudflareaccess.com`.
- `ADMIN_EMAIL`: the one email the policy allows.
- `GH_CLIENT_ID` and `GH_CLIENT_SECRET` (optional): a GitHub OAuth app whose callback is `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`. Alchemy creates the GitHub login method from it. Without them, Access uses the login methods the account already has.

The application covers `/admin*` only, so `/telegram/webhook`, `/hook`, `/a`, `/d` and `/x` stay outside it. The Worker also checks the Access token itself (RS256, issuer, audience, expiry), and `/admin` answers 503 while the team domain or audience is missing.
