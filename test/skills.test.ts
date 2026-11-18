import { Effect } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { Skills } from "../src/skills.ts";

const go = <A, E>(effect: Effect.Effect<A, E, Skills>) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  return Effect.runPromise(Effect.provide(effect, Skills.layer(sql)));
};

test("a skill round-trips, counts reads, pins and deletes", async () => {
  await go(
    Effect.gen(function* () {
      const skills = yield* Skills;
      expect(yield* skills.get("weekly-review")).toBeUndefined();

      const saved = yield* skills.save(
        "weekly-review",
        "Review the week and list open loops.",
        "1. Read the last seven days.\n2. List what is still open.",
      );
      expect(saved.name).toBe("weekly-review");
      expect(saved.useCount).toBe(0);
      expect(saved.pinned).toBe(false);

      expect(yield* skills.index).toEqual([
        { name: "weekly-review", description: "Review the week and list open loops." },
      ]);

      yield* skills.touch("weekly-review");
      const read = yield* skills.get("weekly-review");
      expect(read?.useCount).toBe(1);
      expect(read?.usedAt).toBeTypeOf("number");

      yield* skills.pin("weekly-review");
      expect((yield* skills.get("weekly-review"))?.pinned).toBe(true);

      yield* skills.setPinned("weekly-review", false);
      expect((yield* skills.get("weekly-review"))?.pinned).toBe(false);
      yield* skills.setPinned("weekly-review", true);
      expect((yield* skills.get("weekly-review"))?.pinned).toBe(true);

      yield* skills.save("weekly-review", "Review the week.", "1. Read the last seven days.");
      expect((yield* skills.get("weekly-review"))?.useCount).toBe(1);

      expect(yield* skills.remove("weekly-review")).toBe(true);
      expect(yield* skills.list).toEqual([]);
    }),
  );
});
