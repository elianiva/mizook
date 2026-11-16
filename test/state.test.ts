import { Effect } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { State } from "../src/state.ts";

test("a channel setting can be set, read in the settings and deleted again", async () => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* State;
      yield* state.setMeta("setting:instructions", "talk like a pirate");
      yield* state.setMeta("thread", "t1");
      expect((yield* state.settings).instructions).toBe("talk like a pirate");
      yield* state.deleteMeta("setting:instructions");
      expect((yield* state.settings).instructions).toBeUndefined();
      expect(yield* state.meta("thread")).toBe("t1");
    }).pipe(Effect.provide(State.layer(sql))),
  );
});
