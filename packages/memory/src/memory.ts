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
import type { Kind, Line, Message, SearchHit, ViewBudget } from "./types.ts";
import { render, View, type Rendered } from "./view.ts";

export interface MemoryConfig {
  name: string;
  instructions?: string;
  chatBudget?: ViewBudget;
  compactionBudget?: ViewBudget;
  concurrency?: number;
  waitFor?: Duration.Input;
  modelTimeout?: Duration.Input;
  formatDate?: (date: Date) => string;
}

export interface TurnInput {
  readonly parts: ReadonlyArray<string>;
  readonly markIndex: number;
  readonly text: string;
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

const MAX_CACHED_NODE_TEXTS = 20_000;
const DEFAULT_MODEL_TIMEOUT = "2 minutes";
const DEFAULT_WAIT_FOR_SUMMARIES = "60 seconds";
const MAX_SEARCH_HITS = 50;

export class Memory extends Context.Service<
  Memory,
  {
    readonly systemPrompt: string;
    append(kind: Kind, text: string): Effect.Effect<ReadonlyArray<number>, StoreError>;
    beginTurn(text: string, options?: { context?: string }): Effect.Effect<TurnInput, StoreError>;
    zoom(id: number, n: number): Effect.Effect<string, ZoomError | StoreError>;
    date(id: number): Effect.Effect<string, ZoomError | StoreError>;
    search(query: string, limit: number): Effect.Effect<ReadonlyArray<SearchHit>, StoreError>;
    readonly renderView: Effect.Effect<Rendered, StoreError>;
    readonly stats: Effect.Effect<MemoryStats>;
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
  const chatView = new View(built, config.chatBudget ?? CHAT_BUDGET, saved?.chat);
  const compactionView = new View(
    built,
    config.compactionBudget ?? COMPACTION_BUDGET,
    saved?.compaction,
  );
  const coverMessagesAfterSavedView = (v: View) => {
    for (let i = v.end; i < total; i++) v.append(0, i);
  };
  coverMessagesAfterSavedView(chatView);
  coverMessagesAfterSavedView(compactionView);

  const system = systemPrompt({ name: config.name, instructions: config.instructions });
  const nodeTextCache = new Map<string, string>();
  const evictOldestCachedNodeText = () => nodeTextCache.delete(nodeTextCache.keys().next().value!);

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
    const cached = nodeTextCache.get(key);
    if (cached !== undefined) return cached;
    const node = yield* store.getNode(l, i);
    if (!node) return undefined;
    if (nodeTextCache.size >= MAX_CACHED_NODE_TEXTS) evictOldestCachedNodeText();
    nodeTextCache.set(key, node.text);
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

  const rebalanceAndSave = Effect.suspend(() => {
    const merged = chatView.shrink(total);
    if (merged.length > 0) compactionView.coarsenTo(chatView.lines);
    compactionView.shrink(total);
    return store.saveViews({ chat: chatView.state(), compaction: compactionView.state() });
  });

  const scheduler = new Scheduler(built, () => total, config.concurrency ?? CONCURRENCY);
  const compactor = yield* makeCompactor({
    scheduler,
    system,
    summarizer,
    timeout: config.modelTimeout ?? DEFAULT_MODEL_TIMEOUT,
    message,
    nodeText,
    compactionView: (boundary) => renderLines(compactionView.builtPrefix(boundary)),
    commit: (node) =>
      exclusive(
        Effect.gen(function* () {
          yield* store.putNode(node);
          built.set(node.l, node.i, node.size);
          nodeTextCache.set(`${node.l}:${node.i}`, node.text);
          yield* rebalanceAndSave;
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
      chatView.append(0, i);
      compactionView.append(0, i);
      ids.push(i);
      yield* rebalanceAndSave;
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

  yield* exclusive(rebalanceAndSave);
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
      const caughtUp = yield* compactor.whenSummarized(
        total,
        config.waitFor ?? DEFAULT_WAIT_FOR_SUMMARIES,
      );
      if (!caughtUp)
        yield* Effect.logWarning("turn started before the last messages were summarized");
      return yield* exclusive(
        Effect.gen(function* () {
          const rendered = yield* renderLines(chatView.lines);
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

    search: Effect.fn("Memory.search")(function* (query: string, limit: number) {
      return yield* store.search(query, Math.min(Math.max(limit, 1), MAX_SEARCH_HITS));
    }),

    renderView: exclusive(Effect.suspend(() => renderLines(chatView.lines))),

    stats: Effect.sync(() => ({
      messages: total,
      nodes: [...built.entries()].length,
      chatLines: chatView.lines.length,
      chatBytes: chatView.bytes(),
      compactionBytes: compactionView.bytes(),
      failures: scheduler.failures,
    })),

    idle: compactor.idle,
  });
});
