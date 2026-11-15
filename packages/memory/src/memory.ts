import { Context, DateTime, type Duration, Effect, Layer, Semaphore } from "effect";
import { BuiltIndex } from "./built.ts";
import { makeCompactor } from "./compactor.ts";
import { CHAT_BUDGET, COMPACTION_BUDGET, CONCURRENCY, PLACEHOLDER } from "./constants.ts";
import { StoreError, ZoomError } from "./errors.ts";
import { systemPrompt } from "./prompts.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";
import { Summarizer } from "./summarizer.ts";
import { byteLength, paginate } from "./text.ts";
import { children, label, parseLabel } from "./tree.ts";
import type { Kind, Line, Message, ViewBudget } from "./types.ts";
import { render, View, type Rendered } from "./view.ts";

export interface MemoryConfig {
  /** The agent's name in the system prompt. */
  name: string;
  /** The user's own instructions, appended to the system prompt. */
  instructions?: string;
  chatBudget?: ViewBudget;
  compactionBudget?: ViewBudget;
  /** Compaction calls running at once. */
  concurrency?: number;
  /** How long a turn waits for the last messages to be summarized before it goes ahead. */
  waitFor?: Duration.Input;
  /** How long one model call may take. */
  modelTimeout?: Duration.Input;
  /** How `date(id)` shows a time to the model. Default: ISO 8601 in UTC. */
  formatDate?: (date: Date) => string;
}

export interface TurnInput {
  /** The view and the new message, as the user message of the call. Parts keep the view's cache blocks apart. */
  readonly parts: ReadonlyArray<string>;
  /** Index in `parts` of the last whole view block, where a cache mark goes; -1 if none. */
  readonly markIndex: number;
  readonly text: string;
  /** Ids the user's message was logged under (several when a long text is paged). */
  readonly ids: ReadonlyArray<number>;
}

export interface MemoryStats {
  readonly messages: number;
  readonly nodes: number;
  readonly chatLines: number;
  readonly chatBytes: number;
  readonly compactionBytes: number;
  readonly failures: number;
}

const NODE_CACHE = 20_000;

/**
 * One chat that never ends. The chat itself is the memory: every message is logged word for
 * word, a cheap model compresses the log into a binary tree of one-line summaries, and each turn
 * sees the *view*, summary lines covering the whole chat in 64-128 KB, and zooms where it needs
 * more.
 */
export class Memory extends Context.Service<
  Memory,
  {
    readonly systemPrompt: string;
    /** Log a message. A text too long for one message is logged as several in a row. */
    append(kind: Kind, text: string): Effect.Effect<ReadonlyArray<number>, StoreError>;
    /**
     * Start a turn on a user message. It waits until every message before it is summarized,
     * renders the view, and only then logs the message, which goes whole after the view.
     * `context` is per-turn state (the date, say): it goes after the view and is not logged.
     */
    beginTurn(text: string, options?: { context?: string }): Effect.Effect<TurnInput, StoreError>;
    /** `zoom(id, n)`: open line `id+n` into the two lines it was made from; `n = 1` gives message `id` whole. */
    zoom(id: number, n: number): Effect.Effect<string, ZoomError | StoreError>;
    /** `date(id)`: the date and time of message `id`. */
    date(id: number): Effect.Effect<string, ZoomError | StoreError>;
    /** The chat view as the next turn would see it. */
    readonly renderView: Effect.Effect<Rendered, StoreError>;
    readonly stats: Effect.Effect<MemoryStats>;
    /** Resolves once nothing is being summarized or ready to be. For tests and shutdown. */
    readonly idle: Effect.Effect<void>;
  }
>()("@mizook/memory/Memory") {
  static layer = (config: MemoryConfig): Layer.Layer<Memory, StoreError, Store | Summarizer> =>
    Layer.effect(Memory, make(config));
}

const make = Effect.fnUntraced(function* (config: MemoryConfig) {
  const store = yield* Store;
  const summarizer = yield* Summarizer;
  const lock = yield* Semaphore.make(1);
  const exclusive = lock.withPermits(1);

  const built = new BuiltIndex();
  for (const { l, i, size } of yield* store.nodeSizes) built.set(l, i, size);
  let total = yield* store.messageCount;
  const saved = yield* store.loadViews;
  const view = new View(built, config.chatBudget ?? CHAT_BUDGET, saved?.chat);
  const cview = new View(built, config.compactionBudget ?? COMPACTION_BUDGET, saved?.compaction);
  // A crash can fall between a log write and the save of the views: cover what the log has.
  for (const v of [view, cview]) for (let i = v.end; i < total; i++) v.append(0, i);

  const system = systemPrompt({ name: config.name, instructions: config.instructions });
  const cache = new Map<string, string>();

  const message = Effect.fnUntraced(function* (i: number) {
    const found = yield* store.getMessage(i);
    if (!found)
      return yield* new StoreError({
        operation: "getMessage",
        cause: `message ${i} is not in the log`,
      });
    return found;
  });

  const maybeNodeText = Effect.fnUntraced(function* (l: number, i: number) {
    if (!built.has(l, i)) return undefined;
    const key = `${l}:${i}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const node = yield* store.getNode(l, i);
    if (!node) return undefined;
    if (cache.size >= NODE_CACHE) cache.delete(cache.keys().next().value!);
    cache.set(key, node.text);
    return node.text;
  });

  const nodeText = Effect.fnUntraced(function* (l: number, i: number) {
    const text = yield* maybeNodeText(l, i);
    if (text === undefined)
      return yield* new StoreError({
        operation: "getNode",
        cause: `node ${label(l, i)} is not built`,
      });
    return text;
  });

  const renderLines = Effect.fnUntraced(function* (lines: readonly Line[]) {
    const withText = yield* Effect.forEach(lines, ({ l, i }) =>
      Effect.map(maybeNodeText(l, i), (text) => ({ l, i, text })),
    );
    return render(withText);
  });

  /** Run the batches that are due, keep the compaction view at least as merged as the chat view, and save. */
  const rebalance = Effect.suspend(() => {
    const merged = view.shrink(total);
    if (merged.length > 0) cview.coarsenTo(view.lines);
    cview.shrink(total);
    return store.saveViews({ chat: view.state(), compaction: cview.state() });
  });

  const scheduler = new Scheduler(built, () => total, config.concurrency ?? CONCURRENCY);
  const compactor = yield* makeCompactor({
    scheduler,
    system,
    summarizer,
    timeout: config.modelTimeout ?? "2 minutes",
    message,
    nodeText,
    compactionView: (boundary) => renderLines(cview.builtPrefix(boundary)),
    commit: (node) =>
      exclusive(
        Effect.gen(function* () {
          yield* store.putNode(node);
          built.set(node.l, node.i, node.size);
          cache.set(`${node.l}:${node.i}`, node.text);
          yield* rebalance;
        }),
      ),
  });

  const appendLocked = Effect.fnUntraced(function* (kind: Kind, text: string) {
    const ids: number[] = [];
    for (const page of paginate(text)) {
      const i = total;
      const date = DateTime.formatIso(yield* DateTime.now);
      yield* store.appendMessage({
        i,
        kind,
        text: page,
        size: byteLength(page),
        date,
      } satisfies Message);
      total++;
      view.append(0, i);
      cview.append(0, i);
      ids.push(i);
      yield* rebalance;
    }
    yield* compactor.kick;
    return ids;
  });

  const checkId = (name: string, id: number) =>
    Number.isInteger(id) && id >= 0 && id < total
      ? Effect.void
      : Effect.fail(new ZoomError({ reason: `${name}: the chat has messages 0 to ${total - 1}` }));

  const zoom = Effect.fn("Memory.zoom")(function* (id: number, n: number) {
    if (n === 1) {
      yield* checkId(`zoom(${id}, 1)`, id);
      const found = yield* message(id);
      return `${found.kind}: ${found.text}`;
    }
    const { l, i } = yield* Effect.try({
      try: () => parseLabel(id, n),
      catch: (error) =>
        new ZoomError({ reason: error instanceof Error ? error.message : String(error) }),
    });
    if (id + n > total) {
      return yield* new ZoomError({ reason: `zoom(${id}, ${n}): the chat has ${total} messages` });
    }
    const lines = yield* Effect.forEach(children(l, i), (c) =>
      Effect.map(
        maybeNodeText(c.l, c.i),
        (text) => `${label(c.l, c.i)}|${(text ?? PLACEHOLDER).replace(/\n/g, " ")}`,
      ),
    );
    return lines.join("\n");
  });

  yield* exclusive(rebalance);
  scheduler.init();
  yield* compactor.kick;

  return Memory.of({
    systemPrompt: system,

    append: Effect.fn("Memory.append")((kind: Kind, text: string) =>
      exclusive(appendLocked(kind, text)).pipe(Effect.tap(() => compactor.retryFailed)),
    ),

    beginTurn: Effect.fn("Memory.beginTurn")(function* (
      text: string,
      options?: { context?: string },
    ) {
      yield* compactor.retryFailed;
      // The wait takes seconds: the compactor summarizing the last turn's messages. If it fails
      // to finish, go on: the view then shows what is missing as not summarized yet.
      const caughtUp = yield* compactor.whenSummarized(total, config.waitFor ?? "60 seconds");
      if (!caughtUp)
        yield* Effect.logWarning("turn started before the last messages were summarized");
      return yield* exclusive(
        Effect.gen(function* () {
          const rendered = yield* renderLines(view.lines);
          const ids = yield* appendLocked("user", text);
          const tail = `${rendered.closing}\n\n${options?.context ? `${options.context}\n\n` : ""}${text}`;
          const parts = [...rendered.blocks, tail];
          return {
            parts,
            markIndex: rendered.markIndex,
            text: parts.join(""),
            ids,
          } satisfies TurnInput;
        }),
      ).pipe(Effect.tap(() => compactor.retryFailed));
    }),

    zoom,

    date: Effect.fn("Memory.date")(function* (id: number) {
      yield* checkId(`date(${id})`, id);
      const { date } = yield* message(id);
      return config.formatDate ? config.formatDate(new Date(date)) : date;
    }),

    renderView: exclusive(Effect.suspend(() => renderLines(view.lines))),

    stats: Effect.sync(() => ({
      messages: total,
      nodes: [...built.entries()].length,
      chatLines: view.lines.length,
      chatBytes: view.bytes(),
      compactionBytes: cview.bytes(),
      failures: scheduler.failures,
    })),

    idle: compactor.idle,
  });
});
