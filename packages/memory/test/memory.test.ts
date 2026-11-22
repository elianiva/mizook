import { Arbitrary, Cause, Effect, Exit, Layer, Schema } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vite-plus/test";
import {
  ArchiveError,
  Memory,
  NODE_MAX,
  PLACEHOLDER,
  Scheduler,
  Store,
  ZoomError,
  byteLength,
  clipToolOutput,
  fromFiles,
  sqliteStore,
  toFiles,
  type Kind,
  type Message,
  type Node,
  type Snapshot,
  type Task,
} from "../src/index.ts";
import { BuiltIndex } from "../src/built.ts";
import {
  arrayOf,
  boolean,
  chatPart,
  completeNodes,
  coversInOrder,
  fakeSummarizer,
  inputOf,
  int,
  kind,
  long,
  newModel,
  parseLines,
  run,
  specs,
  storableText,
  text,
  textOf,
  withoutRetryPauses,
  type Spec,
} from "./helpers.ts";
import { property } from "./property.ts";

const sourceOf = (s: Spec, index: number) => `${s.kind}: ${textOf(s, index)}`;

const leafText = (source: string) =>
  byteLength(source) <= NODE_MAX ? source : `S(${source.slice(0, 60).replace(/\n/g, " ")})`;

const appendAll = (messages: readonly Spec[]) =>
  Effect.gen(function* () {
    const memory = yield* Memory;
    for (const [index, s] of messages.entries()) yield* memory.append(s.kind, textOf(s, index));
  });

const sqlite = (db: DatabaseSync) =>
  sqliteStore({ all: (sql, ...params) => db.prepare(sql).all(...(params as never[])) as never });

const powerOfTwo = (n: number) => n >= 1 && (n & (n - 1)) === 0;

property(
  "after any chat settles, every message has a node, every whole subtree is merged, and the view covers the chat once, in order, within budget",
  Arbitrary.all({ messages: specs(1, 40), lo: int(100, 2_000), gap: int(0, 2_000) }),
  ({ messages, lo, gap }) =>
    Effect.promise(async () => {
      const model = newModel();
      const hi = lo + gap;
      const { view, stats } = await run(
        Effect.gen(function* () {
          const memory = yield* Memory;
          yield* appendAll(messages);
          yield* memory.idle;
          return { view: (yield* memory.renderView).text, stats: yield* memory.stats };
        }),
        { model: fakeSummarizer(model), config: { chatBudget: { hi, lo } } },
      );
      const lines = parseLines(chatPart(view));
      expect(coversInOrder(lines, messages.length)).toBe(true);
      expect(stats.failures).toBe(0);
      expect(stats.messages).toBe(messages.length);
      expect(stats.nodes).toBe(completeNodes(messages.length));
      expect(stats.chatLines).toBe(lines.length);
      expect(stats.chatBytes).toBe(byteLength(view) - "<chat>\n".length - "</chat>".length);
      const someLinesCouldStillMerge = lines.some((line, k) => {
        const next = lines[k + 1];
        return next !== undefined && next.n === line.n && line.id % (2 * line.n) === 0;
      });
      expect(stats.chatBytes <= hi || !someLinesCouldStillMerge).toBe(true);
      expect(view).not.toContain(PLACEHOLDER);
      for (const line of lines.filter((line) => line.n === 1))
        expect(line.text).toBe(leafText(sourceOf(messages[line.id]!, line.id)));
    }),
  { runs: 25 },
);

property(
  "short messages are their own node with no model call, and short siblings are joined line by line",
  arrayOf(Arbitrary.all({ kind, text: text(30) }), 1, 4),
  (messages) =>
    Effect.promise(async () => {
      const model = newModel();
      const sources = messages.map((m) => `${m.kind}: ${m.text}`);
      const { view, zoomed } = await run(
        Effect.gen(function* () {
          const memory = yield* Memory;
          for (const m of messages) yield* memory.append(m.kind, m.text);
          yield* memory.idle;
          const zoomed = yield* Effect.forEach(messages, (_, i) => memory.zoom(i, 1));
          return { view: (yield* memory.renderView).text, zoomed };
        }),
        { model: fakeSummarizer(model), config: { chatBudget: { hi: 1, lo: 1 } } },
      );
      expect(model.requests).toHaveLength(0);
      expect(zoomed).toEqual(sources);
      const lines = parseLines(chatPart(view));
      expect(coversInOrder(lines, messages.length)).toBe(true);
      expect(lines.length).toBe(messages.length.toString(2).replace(/0/g, "").length);
      for (const line of lines)
        expect(line.text).toBe(
          sources
            .slice(line.id, line.id + line.n)
            .join(" ")
            .replace(/\n/g, " "),
        );
    }),
  { runs: 40 },
);

property(
  "a compaction sees only built lines that end before its message, with the turns' system prompt",
  Arbitrary.all({ messages: specs(1, 16), concurrency: int(1, 8) }),
  ({ messages, concurrency }) =>
    Effect.promise(async () => {
      const model = newModel();
      const system = await run(
        Effect.gen(function* () {
          const memory = yield* Memory;
          yield* appendAll(messages);
          yield* memory.idle;
          return memory.systemPrompt;
        }),
        { model: fakeSummarizer(model), config: { concurrency } },
      );
      for (const request of model.requests) {
        expect(request.system).toBe(system);
        const prompt = request.messages[0]!.parts.join("");
        expect(prompt).toContain("-".repeat(NODE_MAX));
        const leaf = /compress message (\d+) /.exec(prompt);
        if (!leaf) continue;
        const k = Number(leaf[1]);
        expect(inputOf(request)).toBe(sourceOf(messages[k]!, k));
        for (const line of parseLines(chatPart(prompt)))
          expect(line.id + line.n).toBeLessThanOrEqual(k);
      }
      const leaves = model.requests.filter((r) =>
        /compress message \d+ /.test(r.messages[0]!.parts.join("")),
      ).length;
      expect(leaves).toBe(messages.filter((s, i) => byteLength(sourceOf(s, i)) > NODE_MAX).length);
    }),
  { runs: 20 },
);

property(
  "a reply over the limit is sent back with its size and the cut, and the first reply that fits or else the shortest is kept",
  arrayOf(int(1, 1_000), 5, 5),
  (replies) =>
    Effect.promise(async () => {
      const model = newModel();
      const line = await run(
        Effect.gen(function* () {
          const memory = yield* Memory;
          yield* memory.append("user", long("a"));
          yield* memory.idle;
          return parseLines(chatPart((yield* memory.renderView).text))[0]!.text;
        }),
        {
          model: fakeSummarizer(model, { reply: (_r, n) => "y".repeat(replies[n] ?? 1) }),
          config: { chatBudget: { hi: 1e9, lo: 1e9 } },
        },
      );
      const fits = replies.findIndex((size) => size <= NODE_MAX);
      const tries = fits < 0 ? 5 : fits + 1;
      const shortest = Math.min(...replies);
      const kept = fits >= 0 ? replies[fits]! : shortest > NODE_MAX * 1.25 ? NODE_MAX : shortest;
      expect(model.requests).toHaveLength(tries);
      expect(line).toBe("y".repeat(kept));
      for (let k = 1; k < tries; k++) {
        const turns = model.requests[k]!.messages;
        expect(turns).toHaveLength(2 * k + 1);
        expect(turns[2 * k - 1]!.role).toBe("assistant");
        const feedback = turns[2 * k]!.parts[0]!;
        expect(feedback).toContain(
          `Too long: your line is ${replies[k - 1]} bytes, over the ${NODE_MAX}-byte limit.`,
        );
        expect(feedback).toContain(`${"y".repeat(NODE_MAX)}| ← LIMIT`);
      }
    }),
);

property(
  "a compaction that fails all its tries is counted and tried again at the next message",
  Arbitrary.all({ failing: int(0, 5), next: text(30) }),
  ({ failing, next }) =>
    Effect.promise(() =>
      run(
        Effect.gen(function* () {
          const memory = yield* Memory;
          yield* memory.append("user", long("a"));
          yield* memory.idle;
          const fails = failing >= 3;
          expect((yield* memory.stats).failures).toBe(fails ? 1 : 0);
          expect((yield* memory.stats).nodes).toBe(fails ? 0 : 1);
          yield* memory.append("agent", next);
          yield* memory.idle;
          expect((yield* memory.stats).failures).toBe(0);
          expect((yield* memory.stats).nodes).toBe(3);
        }),
        {
          model: fakeSummarizer(newModel(), {
            reply: (_r, n) => (n < failing ? new Error("boom") : undefined),
          }),
          skipRetryPauses: true,
        },
      ),
    ),
  { runs: 30 },
);

property(
  "compactions run as many at once as the concurrency allows, and never more",
  Arbitrary.all({
    messages: int(1, 12),
    concurrency: Arbitrary.schema(
      Schema.UndefinedOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 }))),
    ),
  }),
  ({ messages, concurrency }) =>
    Effect.promise(async () => {
      const model = newModel();
      await run(
        Effect.gen(function* () {
          const memory = yield* Memory;
          for (let i = 0; i < messages; i++) yield* memory.append("user", long(`m${i}`));
          yield* memory.idle;
        }),
        {
          model: fakeSummarizer(model, { delayMs: 25 }),
          config: concurrency === undefined ? {} : { concurrency },
        },
      );
      expect(model.maxInflight).toBe(Math.min(concurrency ?? 8, messages));
    }),
  { runs: 15 },
);

property(
  "a turn renders the view of the messages before it, then logs its text, which goes whole after the view and its context",
  Arbitrary.all({
    before: arrayOf(Arbitrary.all({ kind, text: text(30) }), 0, 6),
    turn: text(40),
    context: text(20),
  }),
  ({ before, turn, context }) =>
    Effect.promise(() =>
      run(
        Effect.gen(function* () {
          const memory = yield* Memory;
          for (const m of before) yield* memory.append(m.kind, m.text);
          const input = yield* memory.beginTurn(turn, context ? { context } : {});
          expect(input.ids).toEqual([before.length]);
          expect(input.text.startsWith("<chat>\n")).toBe(true);
          expect(input.text.slice(input.text.indexOf("</chat>"))).toBe(
            `</chat>\n\n${context ? `${context}\n\n` : ""}${turn}`,
          );
          expect(input.parts.join("")).toBe(input.text);
          expect(coversInOrder(parseLines(chatPart(input.text)), before.length)).toBe(true);
          expect(yield* memory.zoom(before.length, 1)).toBe(`user: ${turn}`);
          yield* memory.idle;
          const following = yield* memory.beginTurn("next");
          expect(chatPart(following.text)).toContain(
            `\n${before.length}+1|user: ${turn.replace(/\n/g, " ")}\n`,
          );
        }),
        { model: fakeSummarizer(newModel()), config: { chatBudget: { hi: 1e9, lo: 1e9 } } },
      ),
    ),
  { runs: 40 },
);

property(
  "a turn waits for the summaries of the messages before it when they arrive in time",
  Arbitrary.all({ kind, delay: int(0, 30) }),
  ({ kind, delay }) =>
    Effect.promise(async () => {
      const view = await run(
        Effect.gen(function* () {
          const memory = yield* Memory;
          yield* memory.append(kind, long("a"));
          return (yield* memory.beginTurn("next")).text;
        }),
        {
          model: fakeSummarizer(newModel(), { delayMs: delay }),
          config: { chatBudget: { hi: 1e9, lo: 1e9 } },
        },
      );
      expect(view).toContain(`0+1|S(${kind}: a `);
      expect(view).not.toContain(PLACEHOLDER);
    }),
  { runs: 10 },
);

property(
  "a turn goes ahead when the summaries do not arrive in time, and the view says so",
  Arbitrary.all({ kind, wait: int(1, 40) }),
  ({ kind, wait }) =>
    Effect.promise(async () => {
      const view = await run(
        Effect.gen(function* () {
          const memory = yield* Memory;
          yield* memory.append(kind, long("a"));
          return (yield* memory.beginTurn("next")).text;
        }),
        {
          model: fakeSummarizer(newModel(), { delayMs: 10_000 }),
          config: { waitFor: `${wait} millis` },
        },
      );
      expect(view).toContain(`0+1|${PLACEHOLDER}`);
    }),
  { runs: 10 },
);

property(
  "zoom opens any whole line into its two halves and a message into its text, and rejects every other id and size",
  Arbitrary.all({
    messages: specs(1, 20),
    probes: arrayOf(Arbitrary.all({ id: int(-3, 40), n: int(-2, 40) }), 10, 40),
  }),
  ({ messages, probes }) =>
    Effect.promise(() =>
      run(
        Effect.gen(function* () {
          const memory = yield* Memory;
          yield* appendAll(messages);
          yield* memory.idle;
          const total = messages.length;
          const wholeLines = [];
          for (let n = 2; n <= total; n *= 2)
            for (let id = 0; id + n <= total; id += n) wholeLines.push({ id, n });
          for (const { id, n } of [...wholeLines, ...probes]) {
            const exit = yield* Effect.exit(memory.zoom(id, n));
            const valid =
              n === 1
                ? id >= 0 && id < total
                : powerOfTwo(n) && id >= 0 && id % n === 0 && id + n <= total;
            if (!valid) {
              expect(
                Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof ZoomError,
                `zoom(${id}, ${n})`,
              ).toBe(true);
              continue;
            }
            expect(Exit.isSuccess(exit), `zoom(${id}, ${n})`).toBe(true);
            if (!Exit.isSuccess(exit)) continue;
            if (n === 1) {
              expect(exit.value).toBe(sourceOf(messages[id]!, id));
              continue;
            }
            const halves = parseLines(exit.value);
            expect(exit.value.split("\n")).toHaveLength(2);
            expect(halves.map(({ id, n }) => [id, n])).toEqual([
              [id, n / 2],
              [id + n / 2, n / 2],
            ]);
            if (n === 2)
              expect(halves.map((h) => h.text)).toEqual([
                leafText(sourceOf(messages[id]!, id)),
                leafText(sourceOf(messages[id + 1]!, id + 1)),
              ]);
            expect(exit.value).not.toContain(PLACEHOLDER);
          }
          for (const { id } of probes) {
            const exit = yield* Effect.exit(memory.date(id));
            expect(Exit.isSuccess(exit)).toBe(id >= 0 && id < total);
          }
        }),
        { model: fakeSummarizer(newModel()) },
      ),
    ),
  { runs: 25 },
);

const unit = Arbitrary.schema(Schema.Literals(["x", "é", "😀", "line\n", "a b\n", "\n"] as const));

property(
  "a long text is logged as several messages in a row, each within the size limit, that join back to the text",
  arrayOf(Arbitrary.all({ unit, times: int(1, 25_000) }), 1, 4),
  (segments) =>
    Effect.promise(async () => {
      const big = segments.map(({ unit, times }) => unit.repeat(times)).join("");
      const pages = await run(
        Effect.gen(function* () {
          const memory = yield* Memory;
          yield* memory.append("note", "before");
          const logged = yield* memory.append("echo", big);
          expect(logged).toEqual(logged.map((_, k) => k + 1));
          return yield* Effect.forEach(logged, (id) => memory.zoom(id, 1));
        }),
        { model: fakeSummarizer(newModel()), config: { chatBudget: { hi: 1e9, lo: 1e9 } } },
      );
      const texts = pages.map((page) => page.replace(/^echo: /, ""));
      expect(texts.join("")).toBe(big);
      for (const page of texts) expect(byteLength(page)).toBeLessThanOrEqual(30_000);
      expect(pages.length).toBeGreaterThanOrEqual(Math.ceil(byteLength(big) / 30_000));
      if (byteLength(big) <= 30_000) expect(pages).toHaveLength(1);
    }),
  { runs: 20 },
);

const letters = (alphabet: string) =>
  Arbitrary.schema(Schema.Literals(alphabet.split("") as [string, ...string[]]));

const searchCase = Arbitrary.all({
  messages: arrayOf(
    Arbitrary.all({
      kind,
      text: Arbitrary.map(arrayOf(letters("abcdefghijklm "), 0, 40), (cs) => cs.join("")),
      has: boolean,
      at: int(0, 40),
    }),
    1,
    15,
  ),
  word: Arbitrary.map(arrayOf(letters("nopqrstuvwxyz"), 1, 6), (cs) => cs.join("")),
  limit: int(-2, 60),
  upper: boolean,
  padded: boolean,
});

const searchSetup = ({
  messages,
  word,
  upper,
  padded,
}: {
  messages: ReadonlyArray<{ kind: Kind; text: string; has: boolean; at: number }>;
  word: string;
  upper: boolean;
  padded: boolean;
}) => {
  const texts = messages.map(({ text, has, at }) =>
    has ? `${text.slice(0, at)}${word}${text.slice(at)}` : text,
  );
  const query = `${padded ? "  " : ""}${upper ? word.toUpperCase() : word}${padded ? " " : ""}`;
  const holding = texts.flatMap((text, i) => (text.includes(word) ? [i] : []));
  return { texts, query, holding };
};

const clampLimit = (limit: number) => Math.min(Math.max(limit, 1), 50);

property(
  "search finds the first messages holding a word no other message has, up to the limit",
  searchCase,
  (input) =>
    Effect.promise(() =>
      run(
        Effect.gen(function* () {
          const memory = yield* Memory;
          const { texts, query, holding } = searchSetup(input);
          for (const [i, text] of texts.entries())
            yield* memory.append(input.messages[i]!.kind, text);
          const hits = yield* memory.search(query, input.limit);
          expect(hits.map((hit) => hit.i)).toEqual(holding.slice(0, clampLimit(input.limit)));
          for (const hit of hits) {
            expect(hit.kind).toBe(input.messages[hit.i]!.kind);
            expect(hit.snippet).toContain(input.word);
          }
          expect(yield* memory.search(`${input.word}a`, 50)).toEqual(
            texts
              .flatMap((text, i) => (text.includes(`${input.word}a`) ? [i] : []))
              .map((i) => expect.objectContaining({ i })),
          );
        }),
        { model: fakeSummarizer(newModel()) },
      ),
    ),
  { runs: 40 },
);

property(
  "the sqlite store finds the messages holding a word of any length through FTS5, up to the limit",
  searchCase,
  (input) =>
    Effect.promise(() =>
      run(
        Effect.gen(function* () {
          const memory = yield* Memory;
          const { texts, query, holding } = searchSetup(input);
          for (const [i, text] of texts.entries())
            yield* memory.append(input.messages[i]!.kind, text);
          const hits = yield* memory.search(query, input.limit);
          const found = hits.map((hit) => hit.i);
          expect(new Set(found).size).toBe(found.length);
          expect(found.every((i) => holding.includes(i))).toBe(true);
          expect(found).toHaveLength(Math.min(clampLimit(input.limit), holding.length));
          for (const hit of hits) expect(hit.kind).toBe(input.messages[hit.i]!.kind);
          const all = yield* memory.search(query, 50);
          expect(all.map((hit) => hit.i).toSorted((a, b) => a - b)).toEqual(holding);
        }),
        { model: fakeSummarizer(newModel()), store: sqlite(new DatabaseSync(":memory:")) },
      ),
    ),
  { runs: 30 },
);

property(
  "the views are saved in sqlite: a restart loads them, builds nothing again, and carries on",
  Arbitrary.all({ messages: specs(1, 40), next: Arbitrary.all({ kind, text: storableText(40) }) }),
  ({ messages, next }) =>
    Effect.promise(async () => {
      const db = new DatabaseSync(":memory:");
      const settled = Effect.gen(function* () {
        const memory = yield* Memory;
        yield* memory.idle;
        return { view: (yield* memory.renderView).text, stats: yield* memory.stats };
      });
      const first = newModel();
      const before = await run(Effect.andThen(appendAll(messages), settled), {
        model: fakeSummarizer(first),
        store: sqlite(db),
      });
      const second = newModel();
      const after = await run(settled, { model: fakeSummarizer(second), store: sqlite(db) });
      expect(after).toEqual(before);
      expect(second.requests).toHaveLength(0);
      await run(
        Effect.gen(function* () {
          const memory = yield* Memory;
          yield* memory.append(next.kind, next.text);
          yield* memory.idle;
          const stats = yield* memory.stats;
          expect(stats.messages).toBe(messages.length + 1);
          expect(stats.nodes).toBe(completeNodes(messages.length + 1));
          expect(yield* memory.zoom(messages.length, 1)).toBe(`${next.kind}: ${next.text}`);
        }),
        { model: fakeSummarizer(newModel()), store: sqlite(db) },
      );
    }),
  { runs: 10 },
);

property(
  "a restart builds every node a failing model left unbuilt, with no new message",
  specs(1, 6),
  (messages) =>
    Effect.scoped(
      Effect.gen(function* () {
        const stores = yield* Layer.build(Store.inMemory);
        const withModel = <A, E>(
          model: ReturnType<typeof fakeSummarizer>,
          effect: Effect.Effect<A, E, Memory>,
        ) =>
          effect.pipe(
            Effect.provide(
              Memory.layer({
                name: "T",
                chatBudget: { hi: 1e9, lo: 1e9 },
                waitFor: "10 millis",
              }).pipe(Layer.provide(Layer.merge(Layer.succeedContext(stores), model))),
            ),
          );
        const needModel = messages.filter((s, i) => byteLength(sourceOf(s, i)) > NODE_MAX).length;
        yield* withModel(
          fakeSummarizer(newModel(), { reply: () => new Error("down") }),
          Effect.gen(function* () {
            const memory = yield* Memory;
            yield* appendAll(messages);
            yield* memory.idle;
            const stats = yield* memory.stats;
            expect(stats.failures).toBeGreaterThanOrEqual(needModel);
            if (needModel > 0) expect(stats.nodes).toBeLessThan(completeNodes(messages.length));
          }),
        );
        const up = newModel();
        yield* withModel(
          fakeSummarizer(up),
          Effect.gen(function* () {
            const memory = yield* Memory;
            yield* memory.idle;
            expect((yield* memory.stats).nodes).toBe(completeNodes(messages.length));
            expect((yield* memory.stats).failures).toBe(0);
          }),
        );
        expect(up.requests.length).toBeGreaterThanOrEqual(needModel);
      }),
    ).pipe(withoutRetryPauses),
  { runs: 20 },
);

property(
  "the scheduler starts leaves in order within its window, merges only when no leaf can start and both halves are built, and builds every whole subtree",
  Arbitrary.all({
    start: int(0, 40),
    window: int(1, 10),
    concurrency: int(1, 10),
    ops: arrayOf(Arbitrary.all({ pick: int(0, 1_000), grow: int(0, 3), fail: boolean }), 0, 200),
  }),
  ({ start, window, concurrency, ops }) => {
    const built = new BuiltIndex();
    let total = start;
    const scheduler = new Scheduler(built, () => total, concurrency, window);
    const running: Task[] = [];
    const started = new Set<string>();
    const unbuiltLeaves = new Set<number>();
    const failed: Task[] = [];
    const retries: Task[] = [];
    const retryFailed = () => {
      retries.push(...failed.splice(0));
      scheduler.retryFailed();
    };
    let nextLeaf = 0;
    const keyOf = (task: Task) => (task.kind === "leaf" ? `0:${task.i}` : `${task.l}:${task.i}`);
    const startAll = () => {
      for (let task = scheduler.next(); task; task = scheduler.next()) {
        const retried = retries.findIndex((r) => keyOf(r) === keyOf(task));
        if (retried >= 0) {
          retries.splice(retried, 1);
        } else {
          expect(started.has(keyOf(task)), keyOf(task)).toBe(false);
          if (task.kind === "leaf") {
            expect(task.i).toBe(nextLeaf);
            expect(task.i).toBeLessThan(total);
            expect(unbuiltLeaves.size).toBeLessThan(window);
            nextLeaf++;
            unbuiltLeaves.add(task.i);
          } else {
            expect(retries.some((r) => r.kind === "leaf")).toBe(false);
            expect(nextLeaf >= total || unbuiltLeaves.size >= window).toBe(true);
            expect(built.has(task.l - 1, 2 * task.i)).toBe(true);
            expect(built.has(task.l - 1, 2 * task.i + 1)).toBe(true);
            expect(built.has(task.l, task.i)).toBe(false);
          }
        }
        started.add(keyOf(task));
        running.push(task);
        expect(running.length).toBeLessThanOrEqual(concurrency);
      }
    };
    const finish = (pick: number, fail: boolean) => {
      const [task] = running.splice(pick % running.length, 1);
      if (!task) return;
      if (fail) {
        scheduler.fail(task);
        failed.push(task);
        return;
      }
      const node = task.kind === "leaf" ? { l: 0, i: task.i } : { l: task.l, i: task.i };
      built.set(node.l, node.i, 1);
      unbuiltLeaves.delete(node.l === 0 ? node.i : -1);
      scheduler.done(task, node);
    };
    for (const { pick, grow, fail } of ops) {
      if (grow > 0) {
        total += grow;
        retryFailed();
      }
      startAll();
      if (running.length > 0) finish(pick, fail);
    }
    retryFailed();
    startAll();
    while (running.length > 0) {
      finish(0, false);
      startAll();
    }
    expect(scheduler.idle()).toBe(true);
    expect(scheduler.failures).toBe(0);
    expect([...built.entries()]).toHaveLength(completeNodes(total));
    expect(scheduler.summarized(total)).toBe(true);
  },
);

property(
  "a tool's output is kept whole up to the limit, and past it clipped to equal head and tail with the count of what was cut",
  Arbitrary.all({ output: text(120), limit: int(0, 100) }),
  ({ output, limit }) => {
    const clipped = clipToolOutput(output, limit);
    if (output.length <= limit) return clipped === output;
    const half = Math.floor(limit / 2);
    expect(clipped).toBe(
      `${output.slice(0, half)}\n[... ${output.length - 2 * half} characters clipped ...]\n${output.slice(output.length - half)}`,
    );
  },
);

property(
  "by default a tool's output is clipped only past 30,000 characters, to 15,000 at each end",
  Arbitrary.all({ head: int(0, 20_000), tail: int(0, 20_000) }),
  ({ head, tail }) => {
    const output = `${"a".repeat(head)}${"b".repeat(tail)}`;
    const clipped = clipToolOutput(output);
    if (head + tail <= 30_000) return clipped === output;
    expect(clipped.slice(0, 15_000)).toBe(output.slice(0, 15_000));
    expect(clipped.slice(-15_000)).toBe(output.slice(-15_000));
    expect(clipped).toContain(`\n[... ${head + tail - 30_000} characters clipped ...]\n`);
  },
);

const isoDate = Arbitrary.map(int(946_684_800_000, 4_102_444_799_000), (ms) =>
  new Date(ms).toISOString(),
);

const lines = arrayOf(Arbitrary.all([int(0, 12), int(0, 4_000)]), 0, 8);

const snapshotOf = (minMessages: number) =>
  Arbitrary.all({
    messages: arrayOf(Arbitrary.all({ kind, text: text(40), date: isoDate }), minMessages, 30),
    nodes: arrayOf(
      Arbitrary.all({ l: int(0, 6), i: int(0, 40), text: text(40), size: int(0, 600) }),
      0,
      30,
    ),
    views: Arbitrary.schema(Schema.Boolean),
    chat: lines,
    compaction: lines,
    pendingChat: boolean,
    pendingCompaction: boolean,
  }).pipe(
    Arbitrary.map((s): Snapshot => ({
      messages: s.messages.map((m, i): Message => ({
        i,
        kind: m.kind,
        text: m.text,
        size: byteLength(m.text),
        date: m.date,
      })),
      nodes: [...new Map(s.nodes.map((n): [string, Node] => [`${n.l}:${n.i}`, n])).values()],
      views: s.views
        ? {
            chat: { lines: s.chat, pending: s.pendingChat },
            compaction: { lines: s.compaction, pending: s.pendingCompaction },
          }
        : undefined,
    })),
  );

const byNode = (a: Node, b: Node) => a.l - b.l || a.i - b.i;

const snapshot = snapshotOf(0);

property("an archive's files read back to the same log, nodes and views", snapshot, (original) =>
  Effect.gen(function* () {
    const files = toFiles(original);
    const read = yield* fromFiles(files);
    expect(read.messages).toEqual(original.messages);
    expect(read.nodes.toSorted(byNode)).toEqual(original.nodes.toSorted(byNode));
    expect(read.views).toEqual(original.views);
    for (const path of Object.keys(files))
      expect(
        path === "view.json" || /^(main|tree)\/(\d{4}-\d{2}-\d{2}|unknown)\.jsonl$/.test(path),
      ).toBe(true);
    for (const m of original.messages)
      expect(files[`main/${m.date.slice(0, 10)}.jsonl`]).toContain(JSON.stringify(m));
  }),
);

property(
  "an archive with a message missing from its log is not read",
  Arbitrary.all({ snapshot: snapshotOf(2), cut: int(0, 1_000) }),
  ({ snapshot, cut }) =>
    Effect.gen(function* () {
      const missing = cut % (snapshot.messages.length - 1);
      const gapped = { ...snapshot, messages: snapshot.messages.filter((m) => m.i !== missing) };
      const exit = yield* Effect.exit(fromFiles(toFiles(gapped)));
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof ArchiveError).toBe(true);
      expect(String(Cause.squash((exit as Exit.Failure<unknown, unknown>).cause))).toContain(
        `message ${missing} is missing`,
      );
    }),
);

property(
  "a restore into a store that has messages is refused and leaves the store as it was",
  Arbitrary.all({ snapshot, present: int(1, 5) }),
  ({ snapshot, present }) =>
    Effect.gen(function* () {
      const store = yield* Store;
      for (let i = 0; i < present; i++)
        yield* store.appendMessage({
          i,
          kind: "user",
          text: `m${i}`,
          size: 2,
          date: "2026-01-01T00:00:00Z",
        });
      const before = yield* store.snapshot;
      const exit = yield* Effect.exit(store.restore(snapshot));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* store.snapshot).toEqual(before);
    }).pipe(Effect.provide(Store.inMemory)),
);

property(
  "an export restores into an empty store and gives the same view and messages, without a model call",
  Arbitrary.all({ messages: specs(1, 40), probe: int(0, 1_000) }),
  ({ messages, probe }) =>
    Effect.promise(async () => {
      const exported = await run(
        Effect.gen(function* () {
          const memory = yield* Memory;
          yield* appendAll(messages);
          yield* memory.idle;
          const store = yield* Store;
          return { view: (yield* memory.renderView).text, files: toFiles(yield* store.snapshot) };
        }),
        { model: fakeSummarizer(newModel()) },
      );
      const fresh = newModel();
      const k = probe % messages.length;
      const restored = await run(
        Effect.gen(function* () {
          const memory = yield* Memory;
          yield* memory.idle;
          return { view: (yield* memory.renderView).text, zoomed: yield* memory.zoom(k, 1) };
        }),
        {
          model: fakeSummarizer(fresh),
          store: Layer.effect(
            Store,
            Effect.gen(function* () {
              const store = yield* Store;
              yield* store.restore(yield* fromFiles(exported.files).pipe(Effect.orDie));
              return store;
            }).pipe(Effect.provide(Store.inMemory)),
          ),
        },
      );
      expect(restored.view).toBe(exported.view);
      expect(restored.zoomed).toBe(sourceOf(messages[k]!, k));
      expect(fresh.requests).toHaveLength(0);
    }),
  { runs: 10 },
);
