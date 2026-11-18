# @mizook/memory

One chat that never ends. An implementation of the
[UniiChat / OptMem memory design](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449):
the chat itself is the memory.

- Every message is logged word for word, append only.
- In the background a cheap model compresses the log into a binary tree of one-line summaries.
- Each turn sees the **view**: summary lines covering the whole chat, recent ones fine and old
  ones coarse, 64–128 KB in all. Where a line is too vague, the model **zooms**.

The context has a constant size, nothing is lost, and nearly every token is read from the prompt
cache. The package knows nothing about Cloudflare, Telegram, or any model: it takes a `Store` and a
`Summarizer` and gives back a `Memory`. It is written with [Effect](https://effect.website).

## Use

```ts
import { Memory, Store, Summarizer } from "@mizook/memory";
import { sqliteStore } from "@mizook/memory/sqlite";

const MemoryLive = Memory.layer({ name: "Mizook", instructions: "…" }).pipe(
  Layer.provide(Layer.merge(sqliteStore(sql), MySummarizer)), // or Store.inMemory
);

const turn = Effect.gen(function* () {
  const memory = yield* Memory;
  // Waits until every earlier message is summarized, renders the view, then logs the message.
  const input = yield* memory.beginTurn("what did we decide about the schema?");
  // …call the model with memory.systemPrompt, input.parts, and tools backed by memory.zoom / memory.date…
  yield* memory.append("agent", reply);
});
```

| You provide  | It is                                                                       |
| ------------ | --------------------------------------------------------------------------- |
| `Store`      | where the log lives; `Store.inMemory`, or `sqliteStore(driver)` over SQLite |
| `Summarizer` | `complete({ system, messages })`: the cheap model, over any provider        |

| `Memory` gives  |                                                                             |
| --------------- | --------------------------------------------------------------------------- |
| `systemPrompt`  | the one prompt for turns and compactions: never put dates or state in it    |
| `beginTurn`     | view + new message, in cache-sized blocks; logs the message after rendering |
| `append`        | log a message of any kind (`agent`, `tool`, `echo`, …)                      |
| `zoom`, `date`  | the two tools                                                               |
| `search`        | exact words in the log, as message ids and excerpts, for `zoom(id, 1)`      |
| `idle`, `stats` | for tests and monitoring                                                    |

Send `Summarizer` the same tools the turns use (never called): the compaction then reads the
turns' cache entry. Anything else you put before the view breaks that.

## Where each rule of the design lives

| Design                                                          | Code                                 |
| --------------------------------------------------------------- | ------------------------------------ |
| Tree, `id+n` names                                              | `src/tree.ts`                        |
| Merge order: most due pair, oldest of equals; batches 128→64 KB | `src/view.ts` (`mergeOne`, `shrink`) |
| Queues, 8 at a time, "fewer than 8 unbuilt before it"           | `src/scheduler.ts`                   |
| Ruler, too-long retry, shortest of 5                            | `src/compactor.ts`                   |
| Compaction view, same sawtooth at 16–32 KB                      | `src/memory.ts` (`cview`)            |
| System prompt, task texts                                       | `src/prompts.ts`                     |
| Append-only log, saved views                                    | `src/store.ts`, `src/sqlite.ts`      |

`mergeOne` is checked against Taelin's rollback `push` at every step (`test/view.test.ts`): with
the push list's length as the budget it makes exactly the merges `push` makes.

## Differences from the design

- The prompt drops subagents and the user's computers (this agent has neither) and calls the
  agent's replies `agent`, not `unii`.
- A line more than 25% over 512 bytes after five tries is cut at 512 instead of kept, so one line
  cannot eat the budget. A few bytes over is kept, as in the design.
- A turn that waits more than a minute for the last messages to be summarized goes ahead, and the
  view shows those lines as "(not summarized yet: zoom it)".
