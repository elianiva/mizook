import { Effect } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { Intents, matchesTrigger } from "../src/intents.ts";

const go = <A, E>(effect: Effect.Effect<A, E, Intents>) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  return Effect.runPromise(Effect.provide(effect, Intents.layer(sql)));
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test("every trigger must appear, cooldown holds, and the fire budget ends it", async () => {
  const now = Date.now();
  await go(
    Effect.gen(function* () {
      const intents = yield* Intents;
      const made = yield* intents.create(
        "Remind me to check the rollback owner.",
        ["launch", "rollback"],
        { expiresAt: now + 90 * DAY, cooldownMs: HOUR, maxFires: 2 },
      );

      expect(yield* intents.match("the launch is tomorrow", new Date(now))).toEqual([]);
      const first = yield* intents.match(
        "the launch checklist needs a rollback plan",
        new Date(now),
      );
      expect(first.map((intent) => intent.id)).toEqual([made.id]);
      expect(first[0]?.fireCount).toBe(1);

      expect(yield* intents.match("launch and rollback again", new Date(now + HOUR / 2))).toEqual(
        [],
      );

      const second = yield* intents.match("launch and rollback again", new Date(now + HOUR + 1));
      expect(second[0]?.state).toBe("done");
      expect(yield* intents.match("launch and rollback", new Date(now + 2 * HOUR))).toEqual([]);
    }),
  );
});

test("a cancelled intent never fires and an expired one is marked", async () => {
  const now = Date.now();
  await go(
    Effect.gen(function* () {
      const intents = yield* Intents;
      const cancelled = yield* intents.create("This should not fire.", ["dentist"], {
        expiresAt: now + DAY,
        cooldownMs: 0,
        maxFires: 3,
      });
      expect(yield* intents.cancel(cancelled.id)).toBe(true);
      expect(yield* intents.match("dentist tomorrow", new Date(now))).toEqual([]);

      const expired = yield* intents.create("This is already too old.", ["renewal"], {
        expiresAt: now - 1,
        cooldownMs: 0,
        maxFires: 3,
      });
      expect(yield* intents.match("renewal", new Date(now))).toEqual([]);
      const all = yield* intents.list;
      expect(all.find((intent) => intent.id === cancelled.id)?.state).toBe("cancelled");
      expect(all.find((intent) => intent.id === expired.id)?.state).toBe("expired");
    }),
  );
});

test("a trigger matches whole words, and CJK matches as a substring", () => {
  expect(matchesTrigger("the launch is tomorrow", "launch")).toBe(true);
  expect(matchesTrigger("relaunch the site", "launch")).toBe(false);
  expect(matchesTrigger("launch, then rollback.", "launch")).toBe(true);
  expect(matchesTrigger("明天發布，記得檢查", "發布")).toBe(true);
});
