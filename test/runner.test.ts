import { Arbitrary, Effect, Layer, Schema } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vite-plus/test";
import { Automations } from "../src/automations.ts";
import { ActionError } from "../src/errors.ts";
import { Runner, Targets } from "../src/runner.ts";
import { Runs } from "../src/runs.ts";
import { Web } from "../src/search.ts";
import { property } from "./property.ts";

const setup = (options: { failTurn?: string } = {}) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  const calls: Array<[string, ...Array<string | undefined>]> = [];
  const page = { text: "" };
  const targets = Targets.of({
    agentExists: (id) => Effect.succeed(id === "a1"),
    turn: (agent, place, text) =>
      options.failTurn !== undefined
        ? Effect.fail(new ActionError({ reason: options.failTurn }))
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
    Effect.provide(effect, layer);
  const due = () => void sql.all(`UPDATE app_automations SET next_at = 0`);
  return { run, calls, page, due };
};

const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));
const oneOf = <const A extends ReadonlyArray<string>>(values: A) =>
  Arbitrary.schema(Schema.Literals(values));
const word = Arbitrary.array(oneOf(["a", "b", "z", "é", "日", " ", "\n", '"', "\\"]), {
  minLength: 1,
  maxLength: 20,
}).pipe(Arbitrary.map((chars) => chars.join("")));

property(
  "a watch is silent on its first look and on an unchanged page, and brings each changed page to a turn",
  Arbitrary.all({
    pages: Arbitrary.array(oneOf(["v1", "v2", "v3", ""]), { minLength: 1, maxLength: 12 }),
    prompt: word,
    place: oneOf(["telegram:1", "telegram:-5:9", ""]),
  }),
  ({ pages, prompt, place }) => {
    const { run, calls, page, due } = setup();
    return run(
      Effect.gen(function* () {
        const runner = yield* Runner;
        const made = yield* runner.create(
          { kind: "watch", url: "https://a.b/x", everyMinutes: 5 },
          { kind: "turn", agent: "a1", place, prompt },
        );
        for (const text of pages) {
          page.text = text;
          due();
          yield* runner.wake;
        }
        const changed = pages.filter((text, i) => i > 0 && pages[i - 1] !== text);
        expect(calls).toEqual(
          changed.map((text) => [
            "turn",
            "a1",
            place,
            `[automation #${made.id}] ${prompt}\n\nhttps://a.b/x changed. It now reads:\n${text}`,
          ]),
        );
        expect(yield* (yield* Runs).list({ limit: 100 })).toHaveLength(changed.length);
      }),
    );
  },
  { runs: 25 },
);

property(
  "a webhook call fires only a webhook trigger, and any payload reaches the outside call as valid escaped JSON",
  Arbitrary.all({
    payload: Arbitrary.schema(Schema.String),
    otherId: int(3, 50),
  }),
  ({ payload, otherId }) => {
    const { run, calls } = setup();
    return run(
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
        expect(yield* runner.hook(cron.id, payload)).toBeUndefined();
        expect(yield* runner.hook(otherId, payload)).toBeUndefined();
        expect(calls).toEqual([]);
        const fired = yield* runner.hook(hook.id, payload);
        expect(fired).toEqual({ status: "succeeded", output: "200 ok" });
        expect(calls).toHaveLength(1);
        const [kind, url, method, body] = calls[0]!;
        expect([kind, url, method]).toEqual(["call", "https://x.test/in", "POST"]);
        expect(JSON.parse(body!)).toEqual({ msg: `The webhook was called with:\n${payload}` });
      }),
    );
  },
);

property(
  "a turn or post for an agent that does not exist is refused up front, naming the agent",
  Arbitrary.all({
    agent: word.pipe(Arbitrary.filter((a) => a !== "a1")),
    post: Arbitrary.schema(Schema.Boolean),
  }),
  ({ agent, post }) => {
    const { run } = setup();
    return run(
      Effect.gen(function* () {
        const runner = yield* Runner;
        const refused = yield* Effect.flip(
          runner.create(
            { kind: "webhook" },
            post
              ? { kind: "post", agent, place: "", text: "x" }
              : { kind: "turn", agent, place: "", prompt: "x" },
          ),
        );
        expect(refused.message).toBe(`no agent ${agent}`);
        expect(yield* (yield* Automations).all).toEqual([]);
      }),
    );
  },
  { runs: 30 },
);

property(
  "a failed action is a failed run with its reason, cut to a thousand characters, not a thrown error",
  Arbitrary.all({ head: word, padding: int(0, 1_200) }).pipe(
    Arbitrary.map(({ head, padding }) => `${head}${"x".repeat(padding)}`),
  ),
  (reason) => {
    const { run } = setup({ failTurn: reason });
    return run(
      Effect.gen(function* () {
        const runner = yield* Runner;
        const made = yield* runner.create(
          { kind: "webhook" },
          { kind: "turn", agent: "a1", place: "", prompt: "x" },
        );
        expect(yield* runner.test(made.id)).toEqual({ status: "failed", error: reason });
        const [last] = yield* (yield* Runs).list({ limit: 1 });
        expect(last).toMatchObject({
          automationId: made.id,
          status: "failed",
          error: reason.slice(0, 1_000),
          output: "",
        });
      }),
    );
  },
  { runs: 30 },
);
