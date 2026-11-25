# Mizook context

## Glossary

**Agent** — an identity with its own memory, settings, skills and intents. One Durable
Object, `agent:<id>`; the id is random and stable, and the slug (`/grok`) can change. The Hub lists
the agents. A fresh install has two: `mizook`, the default, and `web`, the default for the web chat.

**Place** — where a message was said: a Chat SDK thread id, `telegram:<chat>` or
`telegram:<chat>:<topic>`, or a web thread, `web:<id>`. Turns, replies, approvals and `/stop` are
keyed by place, so one agent can answer in several places at once.

**Web thread** — one conversation in the web chat. The Hub keeps its title, preview and agent. The
agent keeps its transcript in `web_messages`, keyed by the `web:<id>` place. Every web thread that
uses `web` shares that agent's one memory.

**Binding** — a Hub row from a place to an agent. A place with no binding talks to the default
agent. `/<slug> …` sends one message to another agent without changing the binding.

**Chat** — the one conversation the user has with an agent, across all its places. It never ends.
The chat itself is the memory. A user message is logged as `[in <place>] <text>`.

**Message** — one entry of the chat log, with a permanent id. Kinds: `user`, `agent`, `tool`
(a tool call), `echo` (its result), `note` (imported memory). Thoughts are never logged. A text too
long for one message is logged as several in a row. A user message may carry up to four images; the
bytes live in R2 and the turn notes each key, so the agent can read one later.

**Profile** — the short "about you" and the standing rules every agent shares. It lives in the
Hub, not in a chat's memory: identity, not history.

**Role** — what an agent is for: instructions after its persona, and optionally its own persona,
model, and the only tools it gets, by path or namespace. Agents create agents with
`tools.agents.manage`, after approval.

**Program** — the JavaScript a turn runs with `execute`. It calls tools as
`tools.<namespace>.<name>(input)`; each answers with text. The model calls nothing else but
`send_to_user`.

**Skill** — a reusable procedure, saved by name. Agent skills are one agent's; global skills are in
the Hub and every agent sees them. The index goes into a turn; the body is read only
when a task needs it. An automation can name one to read when it fires.

**Intent** — an instruction that waits for a later message to mention its trigger words. It is
prospective memory, not a timer: an automation handles clock time.

**Node** — `node(l, i)` covers the 2^l messages from `i·2^l`. A one-line summary of them, at most
512 bytes, built once. Named `id+n`.

**View** — the list of nodes that covers the whole chat, oldest first, 64–128 KB. What a turn
sees. Saved, never rebuilt. The **compaction view** is the same idea at 16–32 KB.

**Compaction** — one model call that builds one node: compress a message, or merge two nodes.
Same system prompt and tools as a turn, so it reads the turn's prompt cache.

**Zoom** — the tool that opens a line `id+n` into the two lines it was made from; `n = 1` gives
the message whole.

**Turn** — one user message answered. A fresh pi-durable conversation whose only continuity is the
view. A message sent while a turn runs is folded into it between tool calls.

**Pending turn** — a turn started and not yet delivered. Kept in SQLite so that after a restart
the reply is still posted.

**Automation** — a trigger (`once`, `cron`, `watch`, `webhook`) and an action (a turn of an
agent in a place, a fixed post, or an outside call). All of them live in the `Automations`
Durable Object, so one can act for any agent.

**Run** — one firing of an automation, with its status and the reply or error. Kept so a routine can
be inspected, paused, resumed and tested.

## One process owns the chat

`AgentObject` is one Durable Object per agent: it owns the log, pi-durable's storage, and the bot's
state in one SQLite connection. Everything that writes goes through pi-durable's serialized database
wrapper, so no write lands inside one of its transactions.
