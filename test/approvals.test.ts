import { Effect } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { Approvals } from "../src/approvals.ts";

const go = <A, E>(f: Effect.Effect<A, E, Approvals>) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  return Effect.runPromise(Effect.provide(f, Approvals.layer(sql)));
};

test("an approval is shown once and answered once", async () => {
  await go(
    Effect.gen(function* () {
      const approvals = yield* Approvals;
      const a = yield* approvals.add("exec_1", "Send mail?", "gmail.send");
      const b = yield* approvals.add("exec_2", "Delete?");
      expect(a.match).toBe("gmail.send");
      expect(b.match).toBe("");
      expect((yield* approvals.unposted).map((x) => x.id)).toEqual([a.id, b.id]);
      yield* approvals.markPosted(a.id);
      expect((yield* approvals.unposted).map((x) => x.id)).toEqual([b.id]);
      expect((yield* approvals.take(a.id))?.executionId).toBe("exec_1");
      // A second press of the same button finds nothing.
      expect(yield* approvals.take(a.id)).toBeUndefined();
      expect(`approve:${b.id}`.length).toBeLessThan(64);
    }),
  );
});
