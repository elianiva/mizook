import { Effect } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { Runs } from "../src/runs.ts";

const go = <A, E>(effect: Effect.Effect<A, E, Runs>) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  return Effect.runPromise(Effect.provide(effect, Runs.layer(sql)));
};

test("runs are recorded, finished and listed newest first, by automation", async () => {
  await go(
    Effect.gen(function* () {
      const runs = yield* Runs;
      const first = yield* runs.start(1);
      const second = yield* runs.start(2);
      yield* runs.finish(first, "succeeded", "posted the brief");
      yield* runs.finish(second, "failed", "", "source was down");

      const all = yield* runs.list({ limit: 10 });
      expect(all.map((run) => run.id)).toEqual([second, first]);
      expect(all[0]?.status).toBe("failed");
      expect(all[0]?.error).toBe("source was down");
      expect(all[1]?.status).toBe("succeeded");
      expect(all[1]?.output).toBe("posted the brief");
      expect(all[1]?.finished).toBeTypeOf("number");

      expect((yield* runs.list({ limit: 10, automationId: 1 })).map((run) => run.id)).toEqual([
        first,
      ]);
    }),
  );
});
