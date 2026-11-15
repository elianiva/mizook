import { Cause, Effect, Exit, Layer } from "effect";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import {
  Memory,
  Scheduler,
  Store,
  ZoomError,
  byteLength,
  clipToolOutput,
  sqliteStore,
} from "../src/index.ts";
import { BuiltIndex } from "../src/built.ts";
import { fakeSummarizer, inputOf, long, newModel, run } from "./helpers.ts";

const ids = (view: string) =>
  [...view.matchAll(/^(\d+)\+(\d+)\|/gm)].map((m) => [Number(m[1]), Number(m[2])] as const);

test("every message gets a node and the view covers the chat once, in order", async () => {
  const model = newModel();
  const stats = await run(
    Effect.gen(function* () {
      const memory = yield* Memory;
      for (let i = 0; i < 120; i++) yield* memory.append(i % 2 ? "agent" : "user", long(`m${i}`));
      yield* memory.idle;
      const view = yield* memory.renderView;
      const lines = ids(view.text);
      let next = 0;
      for (const [id, n] of lines) {
        expect(id).toBe(next);
        next += n;
      }
      expect(next).toBe(120);
      return yield* memory.stats;
    }),
    { model: fakeSummarizer(model) },
  );
  expect(stats.failures).toBe(0);
  // 120 leaves and 119 merges of a 120-message chat (merges only where both halves are whole).
  expect(stats.nodes).toBeGreaterThanOrEqual(120 + 100);
  // Batches ran: the view is within its budget, far fewer lines than messages.
  expect(stats.chatBytes).toBeLessThanOrEqual(2_000);
  expect(stats.chatLines).toBeLessThan(40);
});

test("short messages are their own node with no model call; two short lines are joined", async () => {
  const model = newModel();
  await run(
    Effect.gen(function* () {
      const memory = yield* Memory;
      yield* memory.append("user", "hello");
      yield* memory.append("agent", "hi there");
      yield* memory.idle;
      expect(yield* memory.zoom(0, 2)).toBe("0+1|user: hello\n1+1|agent: hi there");
      const view = yield* memory.renderView;
      expect(view.text).toBe("<chat>\n0+2|user: hello agent: hi there\n</chat>");
    }),
    { model: fakeSummarizer(model), config: { chatBudget: { hi: 1, lo: 1 } } },
  );
  expect(model.requests).toHaveLength(0);
});

test("a compaction sees the compaction view up to its message, with the turns' system prompt", async () => {
  const model = newModel();
  await run(
    Effect.gen(function* () {
      const memory = yield* Memory;
      for (let i = 0; i < 12; i++) {
        yield* memory.append("user", long(`m${i}`));
        yield* memory.idle;
      }
      const system = memory.systemPrompt;
      expect(model.requests.every((r) => r.system === system)).toBe(true);
    }),
    { model: fakeSummarizer(model), config: { concurrency: 1 } },
  );
  // With one call at a time, the call for message 5 is the 6th leaf (plus earlier merges).
  const forFive = model.requests.find((r) =>
    r.messages[0]!.parts.join("").includes("compress message 5 "),
  )!;
  const text = forFive.messages[0]!.parts.join("");
  const seen = ids(text.slice(0, text.indexOf("</chat>")));
  expect(seen.length).toBeGreaterThan(0);
  for (const [id, n] of seen) expect(id + n).toBeLessThanOrEqual(5);
  // It ends with the task and the ruler.
  expect(text).toContain("-".repeat(512));
  expect(inputOf(forFive).startsWith("user: m5 ")).toBe(true);
});

test("a line over the limit is sent back with the cut; the shortest line wins", async () => {
  const model = newModel();
  const replies = [900, 700, 600, 650, 800];
  await run(
    Effect.gen(function* () {
      const memory = yield* Memory;
      yield* memory.append("user", long("a"));
      yield* memory.idle;
      const line = yield* memory.zoom(0, 1).pipe(Effect.as("x"));
      expect(line).toBe("x");
      const view = yield* memory.renderView;
      // The 600-byte reply was the shortest of five; it is within 25% of the limit, so it is kept whole.
      expect(byteLength(view.text.split("\n")[1]!.replace(/^0\+1\|/, ""))).toBe(600);
    }),
    {
      model: fakeSummarizer(model, {
        reply: (_r, n) => (n < 5 ? "y".repeat(replies[n]!) : undefined),
      }),
      config: { chatBudget: { hi: 1e9, lo: 1e9 } },
    },
  );
  expect(model.requests).toHaveLength(5);
  const second = model.requests[1]!.messages;
  expect(second).toHaveLength(3);
  expect(second[2]!.parts[0]).toContain(
    "Too long: your line is 900 bytes, over the 512-byte limit.",
  );
  expect(second[2]!.parts[0]).toContain("| ← LIMIT");
  expect(second[1]!.role).toBe("assistant");
});

test("a failed call is tried again at the next message", async () => {
  const model = newModel();
  await run(
    Effect.gen(function* () {
      const memory = yield* Memory;
      yield* memory.append("user", long("a"));
      yield* memory.idle;
      expect((yield* memory.stats).failures).toBe(1);
      expect((yield* memory.stats).nodes).toBe(0);
      yield* memory.append("user", "ok");
      yield* memory.idle;
      expect((yield* memory.stats).failures).toBe(0);
      expect((yield* memory.stats).nodes).toBeGreaterThanOrEqual(2);
    }),
    {
      // The first message's call fails, including its two immediate retries.
      model: fakeSummarizer(model, { reply: (_r, n) => (n < 3 ? new Error("boom") : undefined) }),
    },
  );
});

test("compactions run up to 8 at once", async () => {
  const model = newModel();
  await run(
    Effect.gen(function* () {
      const memory = yield* Memory;
      for (let i = 0; i < 40; i++) yield* memory.append("user", long(`m${i}`));
      yield* memory.idle;
    }),
    { model: fakeSummarizer(model, { delayMs: 5 }) },
  );
  expect(model.maxInflight).toBe(8);
});

test("a turn renders the view before logging its message, which goes whole after the view", async () => {
  const model = newModel();
  await run(
    Effect.gen(function* () {
      const memory = yield* Memory;
      yield* memory.append("user", "first");
      yield* memory.append("agent", "second");
      const turn = yield* memory.beginTurn("third\nline", { context: "Now: noon" });
      expect(turn.ids).toEqual([2]);
      // The view holds messages 0 and 1 only; the new message is whole after </chat>.
      expect(turn.text.startsWith("<chat>\n")).toBe(true);
      const afterView = turn.text.slice(turn.text.indexOf("</chat>"));
      expect(afterView).toBe("</chat>\n\nNow: noon\n\nthird\nline");
      expect(
        ids(turn.text.slice(0, turn.text.indexOf("</chat>"))).flatMap(([id, n]) => [id, n]),
      ).toEqual([0, 1, 1, 1]);
      // The log has the user's words only, not the context.
      expect(yield* memory.zoom(2, 1)).toBe("user: third\nline");
      // The next turn's view has it.
      yield* memory.idle;
      const next = yield* memory.beginTurn("fourth");
      expect(next.text).toContain("2+1|user: third line");
    }),
    { model: fakeSummarizer(model), config: { chatBudget: { hi: 1e9, lo: 1e9 } } },
  );
});

test("a turn waits for the messages before it to be summarized", async () => {
  const model = newModel();
  const view = await run(
    Effect.gen(function* () {
      const memory = yield* Memory;
      yield* memory.append("user", long("a"));
      const turn = yield* memory.beginTurn("next");
      return turn.text;
    }),
    { model: fakeSummarizer(model, { delayMs: 50 }), config: { chatBudget: { hi: 1e9, lo: 1e9 } } },
  );
  expect(view).toContain("0+1|S(user: a ");
  expect(view).not.toContain("not summarized yet");
});

test("a turn goes ahead when the summaries do not arrive, and the view says so", async () => {
  const model = newModel();
  const view = await run(
    Effect.gen(function* () {
      const memory = yield* Memory;
      yield* memory.append("user", long("a"));
      return (yield* memory.beginTurn("next")).text;
    }),
    { model: fakeSummarizer(model, { delayMs: 10_000 }), config: { waitFor: "50 millis" } },
  );
  expect(view).toContain("0+1|(not summarized yet: zoom it)");
});

test("zoom opens a line into its two halves, and rejects ids the chat does not have", async () => {
  const model = newModel();
  await run(
    Effect.gen(function* () {
      const memory = yield* Memory;
      for (let i = 0; i < 4; i++) yield* memory.append("user", long(`m${i}`));
      yield* memory.idle;
      const lines = (yield* memory.zoom(0, 4)).split("\n");
      expect(lines.map((l) => l.split("|")[0])).toEqual(["0+2", "2+2"]);
      expect(lines[0]).toContain("S(");
      expect(yield* memory.zoom(2, 2)).toMatch(/^2\+1\|S\(user: m2.*\n3\+1\|S\(user: m3/);
      expect(yield* memory.zoom(3, 1)).toBe(`user: ${long("m3")}`);
      for (const [id, n] of [
        [0, 3],
        [1, 2],
        [0, 8],
        [4, 1],
        [-1, 1],
      ] as const) {
        const exit = yield* Effect.exit(memory.zoom(id, n));
        expect(
          Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof ZoomError,
          `zoom(${id}, ${n})`,
        ).toBe(true);
      }
      const bad = yield* Effect.exit(memory.date(9));
      expect(Exit.isFailure(bad)).toBe(true);
    }),
    { model: fakeSummarizer(model) },
  );
});

test("a long text is logged as several messages in a row, and nothing is cut", async () => {
  const model = newModel();
  const big = Array.from({ length: 4_000 }, (_, i) => `line ${i} ${"é".repeat(10)}`).join("\n");
  await run(
    Effect.gen(function* () {
      const memory = yield* Memory;
      const logged = yield* memory.append("echo", big);
      expect(logged.length).toBeGreaterThan(2);
      const pages = yield* Effect.forEach(logged, (id) => memory.zoom(id, 1));
      expect(pages.map((p) => p.replace(/^echo: /, "")).join("")).toBe(big);
      yield* memory.idle;
    }),
    { model: fakeSummarizer(model), config: { chatBudget: { hi: 1e9, lo: 1e9 } } },
  );
});

test("the views are saved: a restart loads them and builds nothing again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-"));
  const file = join(dir, "chat.sqlite");
  const open = () => {
    const db = new DatabaseSync(file);
    return sqliteStore({
      all: (sql, ...params) => db.prepare(sql).all(...(params as never[])) as never,
    });
  };
  const first = newModel();
  const before = await run(
    Effect.gen(function* () {
      const memory = yield* Memory;
      for (let i = 0; i < 80; i++) yield* memory.append("user", long(`m${i}`));
      yield* memory.idle;
      return { view: (yield* memory.renderView).text, stats: yield* memory.stats };
    }),
    { model: fakeSummarizer(first), store: open() },
  );
  expect(first.requests.length).toBeGreaterThan(80);

  const second = newModel();
  const after = await run(
    Effect.gen(function* () {
      const memory = yield* Memory;
      yield* memory.idle;
      return { view: (yield* memory.renderView).text, stats: yield* memory.stats };
    }),
    { model: fakeSummarizer(second), store: open() },
  );
  expect(after.view).toBe(before.view);
  expect(after.stats).toEqual(before.stats);
  expect(second.requests).toHaveLength(0);

  // And it carries on from there.
  const third = newModel();
  await run(
    Effect.gen(function* () {
      const memory = yield* Memory;
      yield* memory.append("user", long("m80"));
      yield* memory.idle;
      expect((yield* memory.stats).messages).toBe(81);
      expect(yield* memory.zoom(80, 1)).toBe(`user: ${long("m80")}`);
    }),
    { model: fakeSummarizer(third), store: open() },
  );
});

test("restart recovers work that was queued: unbuilt messages are summarized after reopening", async () => {
  const program = Effect.gen(function* () {
    // One store shared by two runs of the memory.
    const stores = yield* Layer.build(Store.inMemory);
    const withModel = <A, E>(
      model: ReturnType<typeof fakeSummarizer>,
      effect: Effect.Effect<A, E, Memory>,
    ) =>
      effect.pipe(
        Effect.provide(
          Memory.layer({ name: "T", chatBudget: { hi: 1e9, lo: 1e9 }, waitFor: "10 millis" }).pipe(
            Layer.provide(Layer.merge(Layer.succeedContext(stores), model)),
          ),
        ),
      );

    // The first run: every model call fails, so nothing is built.
    const down = newModel();
    yield* withModel(
      fakeSummarizer(down, { reply: () => new Error("down") }),
      Effect.gen(function* () {
        const memory = yield* Memory;
        yield* memory.append("user", long("a"));
        yield* memory.append("user", long("b"));
        yield* memory.idle;
        expect((yield* memory.stats).nodes).toBe(0);
      }),
    );

    // The second run starts from the log and builds what is missing, with no new message.
    const up = newModel();
    yield* withModel(
      fakeSummarizer(up),
      Effect.gen(function* () {
        const memory = yield* Memory;
        yield* memory.idle;
        expect((yield* memory.stats).nodes).toBeGreaterThanOrEqual(2);
      }),
    );
    expect(up.requests.length).toBeGreaterThanOrEqual(2);
  });
  await Effect.runPromise(Effect.scoped(program));
});

test("the scheduler starts a message's node only while fewer than 8 lines before it are unbuilt", () => {
  const built = new BuiltIndex();
  let total = 100;
  const scheduler = new Scheduler(built, () => total, 100, 8);
  const started = [];
  for (let t = scheduler.next(); t; t = scheduler.next()) started.push(t);
  expect(started.map((t) => t.kind === "leaf" && t.i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  // Building message 3 (the others still unbuilt) is not enough: 7 lines are unbuilt, so one more starts.
  built.set(0, 3, 5);
  scheduler.done(started[3]!, { l: 0, i: 3 });
  expect(scheduler.next()).toEqual({ kind: "leaf", i: 8 });
  expect(scheduler.next()).toBeUndefined();
  // Building both halves of a pair makes the merge ready, but leaves come first while they can start.
  built.set(0, 2, 5);
  scheduler.done(started[2]!, { l: 0, i: 2 });
  expect(scheduler.next()).toEqual({ kind: "leaf", i: 9 });
  total = 10;
  expect(scheduler.next()).toEqual({ kind: "merge", l: 1, i: 1 });
});

test("a tool's output is clipped to its head and tail, 30,000 characters in all", () => {
  const output = `${"a".repeat(20_000)}${"b".repeat(20_000)}`;
  const clipped = clipToolOutput(output);
  expect(clipped.startsWith("a".repeat(15_000))).toBe(true);
  expect(clipped.endsWith("b".repeat(15_000))).toBe(true);
  expect(clipped).toContain("10000 characters clipped");
  expect(clipToolOutput("short")).toBe("short");
});
