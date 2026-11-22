import { Arbitrary, Effect, Schema } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vite-plus/test";
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
