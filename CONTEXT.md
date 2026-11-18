# Mizook context

## Glossary

**Chat** — the one conversation the user has with the agent. It never ends. The chat itself is the
memory.

**Message** — one entry of the chat log, with a permanent id. Kinds: `user`, `agent`, `tool`
(a tool call), `echo` (its result), `note` (imported memory). Thoughts are never logged. A text too
long for one message is logged as several in a row.

**Profile** — the short "about you" and the standing rules every channel shares. It lives in the
Hub, not in a chat's memory: identity, not history.

**Skill** — a reusable procedure, saved by name. The index goes into a turn; the body is read only
when a task needs it. A schedule can name one to read when it fires.

**Intent** — an instruction that waits for a later message to mention its trigger words. It is
prospective memory, not a timer: a schedule handles clock time.

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

**Run** — one firing of a schedule, with its status and the reply or error. Kept so a routine can
be inspected, paused, resumed and tested.

## One process owns the chat

`ChatAgent` is a single Durable Object: it owns the log, pi-durable's storage, and the bot's state
in one SQLite connection. Everything that writes goes through pi-durable's serialized database
wrapper, so no write lands inside one of its transactions.
