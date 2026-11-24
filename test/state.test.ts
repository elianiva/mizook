import { Arbitrary, Effect, Schema } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { State } from "../src/state.ts";
import { property } from "./property.ts";

const withState = <A, E>(effect: Effect.Effect<A, E, State>) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  return effect.pipe(Effect.provide(State.layer(sql)));
};

const text = Arbitrary.schema(Schema.String).pipe(
  Arbitrary.filter((value) => !/\p{Cs}/u.test(value)),
);

const key = Arbitrary.all({
  prefix: Arbitrary.schema(
    Schema.Literals(["setting:", "Setting:", "SETTING:", "", "thread", "settings", "set"]),
  ),
  name: Arbitrary.schema(Schema.Literals(["instructions", "model", "", "a:b", "timezone"])),
}).pipe(Arbitrary.map(({ prefix, name }) => prefix + name));

const step = Arbitrary.all({
  op: Arbitrary.schema(Schema.Literals(["set", "delete"])),
  key,
  value: text,
});

property(
  "after any run of sets and deletes, each key reads its last value and the settings are exactly the setting: keys",
  Arbitrary.array(step, { maxLength: 12 }),
  (steps) =>
    withState(
      Effect.gen(function* () {
        const state = yield* State;
        const model = new Map<string, string>();
        for (const { op, key, value } of steps) {
          if (op === "set") {
            yield* state.setMeta(key, value);
            model.set(key, value);
          } else {
            yield* state.deleteMeta(key);
            model.delete(key);
          }
        }
        for (const { key } of steps) expect(yield* state.meta(key)).toBe(model.get(key));
        const expected = Object.fromEntries(
          [...model]
            .filter(([k]) => k.startsWith("setting:"))
            .map(([k, v]) => [k.slice("setting:".length), v]),
        );
        expect(yield* state.settings).toEqual(expected);
      }),
    ),
  { runs: 40 },
);

test("a place's thread holds only what was said there, oldest first, newest 100 kept", () =>
  Effect.runPromise(
    withState(
      Effect.gen(function* () {
        const state = yield* State;
        yield* state.say("web:a", "user", "hey");
        yield* state.say("web:b", "user", "elsewhere");
        yield* state.say("web:a", "agent", "hi");
        expect(yield* state.thread("web:a")).toEqual([
          { role: "user", text: "hey" },
          { role: "agent", text: "hi" },
        ]);
        for (let i = 0; i < 120; i++) yield* state.say("web:c", "user", `m${i}`);
        const kept = yield* state.thread("web:c");
        expect(kept).toHaveLength(100);
        expect(kept[0]?.text).toBe("m20");
        expect(kept.at(-1)?.text).toBe("m119");
        expect(yield* state.thread("web:b")).toEqual([{ role: "user", text: "elsewhere" }]);
      }),
    ),
  ));

test("a setting refuses a value no path may save, keeps the old one, and clears back to the default", () =>
  Effect.runPromise(
    withState(
      Effect.gen(function* () {
        const state = yield* State;
        yield* state.setSetting("model", "deepseek/v4");
        yield* state.setSetting("instructions", "be brief");
        yield* state.setSetting("timezone", "Asia/Jakarta");
        yield* state.setSetting("budget", "2.5");
        const kept = yield* state.settings;
        for (const [key, value] of [
          ["model", "two words"],
          ["model", "m".repeat(121)],
          ["instructions", "i".repeat(4_001)],
          ["timezone", "Mars/Base"],
          ["budget", "-1"],
          ["budget", "lots"],
        ] as const) {
          const refused = yield* Effect.flip(state.setSetting(key, value));
          expect(refused._tag).toBe("InvalidInput");
        }
        expect(yield* state.settings).toEqual(kept);
        yield* state.setSetting("model", undefined);
        expect((yield* state.settings)["model"]).toBeUndefined();
      }),
    ),
  ));
