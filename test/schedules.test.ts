import { Effect, Exit } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { Schedules } from "../src/schedules.ts";

const go = <A, E>(f: Effect.Effect<A, E, Schedules>) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  return Effect.runPromise(Effect.provide(f, Schedules.layer(sql)));
};

const t = (s: string) => new Date(s);
const cron = { kind: "cron", expr: "*/10 * * * *", timezone: "UTC" } as const;

test("a once fires once, then is finished", async () => {
  await go(
    Effect.gen(function* () {
      const s = yield* Schedules;
      const made = yield* s.create(
        { kind: "once", at: "2026-11-15T10:00:00Z" },
        "call mum",
        t("2026-11-15T09:00:00Z"),
      );
      expect(yield* s.claim(t("2026-11-15T09:59:00Z"))).toEqual([]);
      expect((yield* s.claim(t("2026-11-15T10:00:01Z"))).map((x) => x.id)).toEqual([made.id]);
      expect(yield* s.claim(t("2026-11-15T10:05:00Z"))).toEqual([]);
      expect(yield* s.list).toEqual([]);
      expect(yield* s.nextAt).toBeUndefined();
    }),
  );
});

test("a cron missed for hours fires once and then waits for the next slot", async () => {
  await go(
    Effect.gen(function* () {
      const s = yield* Schedules;
      yield* s.create(cron, "tick", t("2026-11-15T00:00:00Z"));
      const woke = t("2026-11-15T05:03:00Z");
      expect(yield* s.claim(woke)).toHaveLength(1);
      expect(yield* s.claim(woke)).toHaveLength(0);
      expect(new Date((yield* s.nextAt)!).toISOString()).toBe("2026-11-15T05:10:00.000Z");
    }),
  );
});

test("a bad spec is refused with its reason, and cancel stops a schedule", async () => {
  await go(
    Effect.gen(function* () {
      const s = yield* Schedules;
      const bad = yield* Effect.exit(
        s.create({ kind: "once", at: "2020-01-01T00:00:00Z" }, "x", t("2026-11-15T00:00:00Z")),
      );
      expect(Exit.isFailure(bad)).toBe(true);
      const made = yield* s.create(cron, "tick", t("2026-11-15T00:00:00Z"));
      expect(yield* s.cancel(made.id)).toBe(true);
      expect(yield* s.cancel(made.id)).toBe(false);
      expect(yield* s.claim(t("2026-11-16T00:00:00Z"))).toEqual([]);
    }),
  );
});

test("a watch is silent on the first look and on no change, and speaks on a change", async () => {
  await go(
    Effect.gen(function* () {
      const s = yield* Schedules;
      const w = yield* s.create(
        { kind: "watch", url: "https://a.b/x", everyMinutes: 10 },
        "tell me",
        t("2026-11-15T00:00:00Z"),
      );
      expect(yield* s.watchChanged(w.id, "h1")).toBe(false);
      expect(yield* s.watchChanged(w.id, "h1")).toBe(false);
      expect(yield* s.watchChanged(w.id, "h2")).toBe(true);
    }),
  );
});

test("the hourly limit refuses a fire past the cap and recovers after an hour", async () => {
  await go(
    Effect.gen(function* () {
      const s = yield* Schedules;
      const base = t("2026-11-15T00:00:00Z");
      expect(yield* s.allow(base, 2)).toBe(true);
      expect(yield* s.allow(base, 2)).toBe(true);
      expect(yield* s.allow(base, 2)).toBe(false);
      expect(yield* s.allow(t("2026-11-15T01:00:01Z"), 2)).toBe(true);
    }),
  );
});
