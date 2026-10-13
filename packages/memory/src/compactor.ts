import { Deferred, Duration, Effect, Option, Schedule, type Scope } from "effect";
import { CompletionError, type StoreError } from "./errors.ts";
import { MAX_TRIES, NODE_MAX } from "./constants.ts";
import { leafTask, mergeTask, tooLong } from "./prompts.ts";
import type { Scheduler, Task } from "./scheduler.ts";
import type { Summarizer, Turn } from "./summarizer.ts";
import { byteLength, takeBytes } from "./text.ts";
import { children, first, last } from "./tree.ts";
import type { Message, Node } from "./types.ts";
import type { Rendered } from "./view.ts";

export interface CompactorDeps {
  scheduler: Scheduler;
  system: string;
  summarizer: Summarizer["Service"];
  /** Each model call gets this long. */
  timeout: Duration.Input;
  message(i: number): Effect.Effect<Message, StoreError>;
  nodeText(l: number, i: number): Effect.Effect<string, StoreError>;
  /** The compaction view: the lines before `boundary`, built ones only. */
  compactionView(boundary: number): Effect.Effect<Rendered, StoreError>;
  /** Store the node, mark it built, and let the views merge. */
  commit(node: Node): Effect.Effect<void, StoreError>;
}

export interface Compactor {
  /** Look for work: a message was logged, or something was built. */
  readonly kick: Effect.Effect<void>;
  /** A failed call is tried again at the next message. */
  readonly retryFailed: Effect.Effect<void>;
  /** True once every message before `count` is summarized; false after `wait`. */
  whenSummarized(count: number, wait: Duration.Input): Effect.Effect<boolean>;
  /** Resolves once nothing is running or ready to run. Failed tasks wait for `retryFailed`. */
  readonly idle: Effect.Effect<void>;
}

interface Waiter {
  check: () => boolean;
  done: Deferred.Deferred<void>;
}

/** Builds the tree: runs the scheduler's tasks as fibers of the enclosing scope. */
export const makeCompactor = Effect.fnUntraced(function* (
  deps: CompactorDeps,
): Effect.fn.Return<Compactor, never, Scope.Scope> {
  const { scheduler } = deps;
  const scope = yield* Effect.scope;
  const waiters = new Set<Waiter>();

  const settle = Effect.gen(function* () {
    for (const waiter of waiters) {
      if (waiter.check()) yield* Deferred.succeed(waiter.done, undefined);
    }
  });

  const waitUntil = Effect.fnUntraced(function* (check: () => boolean) {
    if (check()) return;
    const done = yield* Deferred.make<void>();
    const waiter: Waiter = { check, done };
    waiters.add(waiter);
    yield* Deferred.await(done).pipe(Effect.ensuring(Effect.sync(() => waiters.delete(waiter))));
  });

  /**
   * One line from the model. It can't count bytes: the task shows a ruler, and a reply over the
   * limit is sent back, in the same conversation, with the cut. Up to 5 tries; the shortest wins.
   */
  const summarize = Effect.fnUntraced(function* (boundary: number, task: string) {
    const view = yield* deps.compactionView(boundary);
    const messages: Turn[] = [
      { role: "user", parts: [...view.blocks, `${view.closing}\n\n${task}`] },
    ];
    let best: string | undefined;
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      const reply = yield* deps.summarizer
        .complete({ system: deps.system, messages: [...messages] })
        .pipe(
          Effect.timeout(deps.timeout),
          Effect.catchTag("TimeoutError", (cause) => Effect.fail(new CompletionError({ cause }))),
          // A transient failure is not worth a whole node; a persistent one fails the task, which is retried at the next message.
          Effect.retry({ times: 2, schedule: Schedule.exponential("500 millis") }),
        );
      const line = reply.trim().replace(/^\d+\+\d+\|/, "");
      if (line === "") continue;
      const size = byteLength(line);
      if (best === undefined || size < byteLength(best)) best = line;
      if (size <= NODE_MAX) return line;
      messages.push(
        { role: "assistant", parts: [reply] },
        { role: "user", parts: [tooLong(size, takeBytes(line, NODE_MAX))] },
      );
    }
    if (best === undefined)
      return yield* new CompletionError({ cause: "the model returned no line" });
    // A few bytes over is fine, the view measures real sizes. Far over would let one line eat the budget.
    return byteLength(best) > NODE_MAX * 1.25 ? takeBytes(best, NODE_MAX) : best;
  });

  const buildLeaf = Effect.fnUntraced(function* (i: number) {
    const message = yield* deps.message(i);
    const source = `${message.kind}: ${message.text}`;
    // A source that fits is its own node, with no model call.
    const text = byteLength(source) <= NODE_MAX ? source : yield* summarize(i, leafTask(i, source));
    return { l: 0, i, text, size: byteLength(text) } satisfies Node;
  });

  const buildMerge = Effect.fnUntraced(function* (l: number, i: number) {
    const [a, b] = children(l, i);
    const [textA, textB] = yield* Effect.all([deps.nodeText(a.l, a.i), deps.nodeText(b.l, b.i)]);
    const joined = `${textA}\n${textB}`;
    const text =
      byteLength(joined) <= NODE_MAX
        ? joined
        : yield* summarize(last(l, i) + 1, mergeTask(a, b, first(l, i), last(l, i), textA, textB));
    return { l, i, text, size: byteLength(text) } satisfies Node;
  });

  const describe = (task: Task) =>
    task.kind === "leaf" ? `message ${task.i}` : `node ${task.l}:${task.i}`;

  const run = (task: Task): Effect.Effect<void> =>
    (task.kind === "leaf" ? buildLeaf(task.i) : buildMerge(task.l, task.i)).pipe(
      Effect.tap((node) => deps.commit(node)),
      Effect.matchCauseEffect({
        onSuccess: (node) => Effect.sync(() => scheduler.done(task, node)),
        onFailure: (cause) =>
          Effect.sync(() => scheduler.fail(task)).pipe(
            Effect.andThen(Effect.logWarning(`compaction of ${describe(task)} failed`, cause)),
          ),
      }),
      Effect.andThen(() => kick),
      Effect.withSpan("memory.compact", { attributes: { task: describe(task) } }),
    );

  const kick: Effect.Effect<void> = Effect.gen(function* () {
    for (let task = scheduler.next(); task; task = scheduler.next()) {
      yield* Effect.forkIn(run(task), scope);
    }
    yield* settle;
  });

  return {
    kick,
    retryFailed: Effect.andThen(
      Effect.sync(() => scheduler.retryFailed()),
      kick,
    ),
    whenSummarized: (count, wait) =>
      waitUntil(() => scheduler.summarized(count)).pipe(
        Effect.timeoutOption(wait),
        Effect.map(Option.isSome),
      ),
    idle: waitUntil(() => scheduler.idle()),
  };
});
