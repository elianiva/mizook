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
  timeout: Duration.Input;
  message(i: number): Effect.Effect<Message, StoreError>;
  nodeText(l: number, i: number): Effect.Effect<string, StoreError>;
  compactionView(boundary: number): Effect.Effect<Rendered, StoreError>;
  commit(node: Node): Effect.Effect<void, StoreError>;
}

export interface Compactor {
  readonly kick: Effect.Effect<void>;
  readonly retryFailed: Effect.Effect<void>;
  whenSummarized(count: number, wait: Duration.Input): Effect.Effect<boolean>;
  readonly idle: Effect.Effect<void>;
}

const LABEL_HEAD = /^\d+\+\d+\|/;
const TOLERATED_NODE_OVERSHOOT = 1.25;
const MAX_KEPT_LINE_BYTES = NODE_MAX * TOLERATED_NODE_OVERSHOOT;

const retryTransientCompletionFailure = {
  times: 2,
  schedule: Schedule.exponential("500 millis"),
};

const fitsInNode = (text: string) => byteLength(text) <= NODE_MAX;

const stripLabelHead = (line: string) => line.replace(LABEL_HEAD, "");

const cutIfFarOverNodeLimit = (line: string) =>
  byteLength(line) > MAX_KEPT_LINE_BYTES ? takeBytes(line, NODE_MAX) : line;

interface Waiter {
  check: () => boolean;
  done: Deferred.Deferred<void>;
}

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

  const summarizeIntoOneLine = Effect.fnUntraced(function* (
    compactionViewBoundary: number,
    task: string,
  ) {
    const view = yield* deps.compactionView(compactionViewBoundary);
    const conversation: Turn[] = [
      { role: "user", parts: [...view.blocks, `${view.closing}\n\n${task}`] },
    ];
    let shortestLine: string | undefined;
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      const reply = yield* deps.summarizer
        .complete({ system: deps.system, messages: [...conversation] })
        .pipe(
          Effect.timeout(deps.timeout),
          Effect.catchTag("TimeoutError", (cause) => Effect.fail(new CompletionError({ cause }))),
          Effect.retry(retryTransientCompletionFailure),
        );
      const line = stripLabelHead(reply.trim());
      if (line === "") continue;
      const size = byteLength(line);
      if (shortestLine === undefined || size < byteLength(shortestLine)) shortestLine = line;
      if (fitsInNode(line)) return line;
      conversation.push(
        { role: "assistant", parts: [reply] },
        { role: "user", parts: [tooLong(size, takeBytes(line, NODE_MAX))] },
      );
    }
    if (shortestLine === undefined)
      return yield* new CompletionError({ cause: "the model returned no line" });
    return cutIfFarOverNodeLimit(shortestLine);
  });

  const buildLeaf = Effect.fnUntraced(function* (i: number) {
    const message = yield* deps.message(i);
    const source = `${message.kind}: ${message.text}`;
    const text = fitsInNode(source) ? source : yield* summarizeIntoOneLine(i, leafTask(i, source));
    return { l: 0, i, text, size: byteLength(text) } satisfies Node;
  });

  const buildMerge = Effect.fnUntraced(function* (l: number, i: number) {
    const [a, b] = children(l, i);
    const [textA, textB] = yield* Effect.all([deps.nodeText(a.l, a.i), deps.nodeText(b.l, b.i)]);
    const joined = `${textA}\n${textB}`;
    const oneAfterLastCoveredMessage = last(l, i) + 1;
    const text = fitsInNode(joined)
      ? joined
      : yield* summarizeIntoOneLine(
          oneAfterLastCoveredMessage,
          mergeTask(a, b, first(l, i), last(l, i), textA, textB),
        );
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
