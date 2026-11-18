import { Effect } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { Policies } from "../src/policies.ts";

const go = <A, E>(effect: Effect.Effect<A, E, Policies>) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  return Effect.runPromise(Effect.provide(effect, Policies.layer(sql)));
};

test("deny beats ask, ask beats allow, and the same rule is not stored twice", async () => {
  await go(
    Effect.gen(function* () {
      const policies = yield* Policies;
      const allow = yield* policies.add("gmail.send", "allow");
      const ask = yield* policies.add("gmail", "ask");
      const deny = yield* policies.add("delete", "deny");

      expect(yield* policies.decide("call gmail.send email")).toBe("ask");
      expect(yield* policies.decide("call delete file")).toBe("deny");
      expect(yield* policies.decide("call calendar.list")).toBeUndefined();

      const again = yield* policies.add("gmail.send", "allow");
      expect(again.id).toBe(allow.id);
      expect(yield* policies.list).toHaveLength(3);

      expect(yield* policies.remove(deny.id)).toBe(true);
      expect(yield* policies.remove(deny.id)).toBe(false);
      expect(yield* policies.decide("call gmail.send email")).toBe("ask");
      expect(yield* policies.decide("call delete file")).toBeUndefined();
      expect(ask.decision).toBe("ask");
    }),
  );
});
