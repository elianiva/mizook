import { Effect, Layer } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { Automations } from "../src/automations.ts";
import { ActionError } from "../src/errors.ts";
import { Runner, Targets } from "../src/runner.ts";
import { Runs } from "../src/runs.ts";
import { Web } from "../src/search.ts";

/** A runner over an in-memory store, with targets that record calls and a page that can change. */
const setup = (options: { failTurn?: boolean } = {}) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  const calls: unknown[][] = [];
  const page = { text: "v1" };
  const targets = Targets.of({
    agentExists: (id) => Effect.succeed(id === "a1"),
    turn: (agent, place, text) =>
      options.failTurn
        ? Effect.fail(new ActionError({ reason: "agent is gone" }))
        : Effect.sync(() => {
            calls.push(["turn", agent, place, text]);
            return "done";
          }),
    post: (agent, place, text) => Effect.sync(() => void calls.push(["post", agent, place, text])),
    call: (url, method, body) =>
      Effect.sync(() => {
        calls.push(["call", url, method, body]);
        return "200 ok";
      }),
  });
  const web = Web.of({
    search: () => Effect.succeed(""),
    fetch: () =>
      Effect.sync(() => ({
        status: 200,
        contentType: "text/plain",
        text: page.text,
        truncated: false,
      })),
  });
  const layer = Runner.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(Automations.layer(sql), Runs.layer(sql))),
    Layer.provide(Layer.merge(Layer.succeed(Targets, targets), Layer.succeed(Web, web))),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, Runner | Automations | Runs>) =>
    Effect.runPromise(Effect.provide(effect, layer));
  /** Make every automation due now, as if its time had come. */
  const due = () => void sql.all(`UPDATE app_automations SET next_at = 0`);
  return { run, calls, page, due };
};

test("a watch is silent on its first look and on no change, and brings the new page on a change", async () => {
  const { run, calls, page, due } = setup();
  await run(
    Effect.gen(function* () {
      const runner = yield* Runner;
      yield* runner.create(
        { kind: "watch", url: "https://a.b/x", everyMinutes: 5 },
        { kind: "turn", agent: "a1", place: "telegram:1", prompt: "tell me" },
      );
      for (const text of ["v1", "v1", "v2"]) {
        page.text = text;
        due();
        yield* runner.wake;
      }
    }),
  );
  expect(calls).toHaveLength(1);
  const [kind, agent, place, text] = calls[0] as string[];
  expect([kind, agent, place]).toEqual(["turn", "a1", "telegram:1"]);
  expect(text).toMatch(
    /^\[automation #1\] tell me\n\nhttps:\/\/a\.b\/x changed\. It now reads:\nv2$/,
  );
});

test("a webhook call fires only a webhook trigger, and its body reaches an outside call escaped", async () => {
  const { run, calls } = setup();
  await run(
    Effect.gen(function* () {
      const runner = yield* Runner;
      const hook = yield* runner.create(
        { kind: "webhook" },
        {
          kind: "webhook",
          url: "https://x.test/in",
          method: "POST",
          body: '{"msg":"{{payload}}"}',
        },
      );
      const cron = yield* runner.create(
        { kind: "cron", expr: "0 9 * * *", timezone: "UTC" },
        { kind: "post", agent: "a1", place: "", text: "morning" },
      );
      expect(yield* runner.hook(cron.id, "x")).toBeUndefined();
      const fired = yield* runner.hook(hook.id, 'say "hi"\nbye');
      expect(fired?.status).toBe("succeeded");
    }),
  );
  expect(calls).toHaveLength(1);
  const body = (calls[0] as string[])[3]!;
  // The body stays valid JSON however the payload is quoted.
  expect(JSON.parse(body).msg).toBe('The webhook was called with:\nsay "hi"\nbye');
});

test("a failed action is a failed run, not a thrown error, and an unknown agent is refused up front", async () => {
  const { run } = setup({ failTurn: true });
  await run(
    Effect.gen(function* () {
      const runner = yield* Runner;
      const refused = yield* Effect.flip(
        runner.create(
          { kind: "webhook" },
          { kind: "turn", agent: "nobody", place: "", prompt: "x" },
        ),
      );
      expect(refused.message).toBe("no agent nobody");
      const made = yield* runner.create(
        { kind: "webhook" },
        { kind: "turn", agent: "a1", place: "", prompt: "x" },
      );
      expect(yield* runner.test(made.id)).toEqual({
        status: "failed",
        error: "agent is gone",
      });
      const [last] = yield* (yield* Runs).list({ limit: 1 });
      expect(last).toMatchObject({
        automationId: made.id,
        status: "failed",
        error: "agent is gone",
      });
    }),
  );
});
