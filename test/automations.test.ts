import { Effect, Exit } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { Automations } from "../src/automations.ts";
import type { Action } from "../src/schedule.ts";

const go = <A, E>(f: Effect.Effect<A, E, Automations>) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  return Effect.runPromise(Effect.provide(f, Automations.layer(sql)));
};

const t = (s: string) => new Date(s);
const cron = { kind: "cron", expr: "*/10 * * * *", timezone: "UTC" } as const;
const say = (prompt: string): Action => ({ kind: "turn", agent: "a1", place: "", prompt });

test("a once fires once, then is finished", async () => {
  await go(
    Effect.gen(function* () {
      const s = yield* Automations;
      const made = yield* s.create(
        { kind: "once", at: "2026-11-15T10:00:00Z" },
        say("call mum"),
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
      const s = yield* Automations;
      yield* s.create(cron, say("tick"), t("2026-11-15T00:00:00Z"));
      const woke = t("2026-11-15T05:03:00Z");
      expect(yield* s.claim(woke)).toHaveLength(1);
      expect(yield* s.claim(woke)).toHaveLength(0);
      expect(new Date((yield* s.nextAt)!).toISOString()).toBe("2026-11-15T05:10:00.000Z");
    }),
  );
});

test("a bad spec is refused with its reason, and cancel stops an automation", async () => {
  await go(
    Effect.gen(function* () {
      const s = yield* Automations;
      const bad = yield* Effect.exit(
        s.create({ kind: "once", at: "2020-01-01T00:00:00Z" }, say("x"), t("2026-11-15T00:00:00Z")),
      );
      expect(Exit.isFailure(bad)).toBe(true);
      const made = yield* s.create(cron, say("tick"), t("2026-11-15T00:00:00Z"));
      expect(yield* s.cancel(made.id)).toBe(true);
      expect(yield* s.cancel(made.id)).toBe(false);
      expect(yield* s.claim(t("2026-11-16T00:00:00Z"))).toEqual([]);
    }),
  );
});

test("a paused automation is hidden from the active list and resumes at its next time", async () => {
  await go(
    Effect.gen(function* () {
      const s = yield* Automations;
      const made = yield* s.create(cron, say("tick"), t("2026-11-15T00:00:00Z"));
      expect(yield* s.pause(made.id)).toBe(true);
      expect(yield* s.list).toEqual([]);
      expect((yield* s.all)[0]?.active).toBe(false);
      expect(yield* s.resume(made.id, t("2026-11-15T05:03:00Z"))).toBe(true);
      expect(yield* s.list).toHaveLength(1);
      expect(new Date((yield* s.nextAt)!).toISOString()).toBe("2026-11-15T05:10:00.000Z");
    }),
  );
});

test("a watch is silent on the first look and on no change, and speaks on a change", async () => {
  await go(
    Effect.gen(function* () {
      const s = yield* Automations;
      const w = yield* s.create(
        { kind: "watch", url: "https://a.b/x", everyMinutes: 10 },
        say("tell me"),
        t("2026-11-15T00:00:00Z"),
      );
      expect(yield* s.watchChanged(w.id, "h1")).toBe(false);
      expect(yield* s.watchChanged(w.id, "h1")).toBe(false);
      expect(yield* s.watchChanged(w.id, "h2")).toBe(true);
    }),
  );
});

test("the hourly limit, per agent, refuses a fire past the cap and recovers after an hour", async () => {
  await go(
    Effect.gen(function* () {
      const s = yield* Automations;
      const base = t("2026-11-15T00:00:00Z");
      expect(yield* s.allow(base, 2, "a1")).toBe(true);
      expect(yield* s.allow(base, 2, "a1")).toBe(true);
      expect(yield* s.allow(base, 2, "a1")).toBe(false);
      // Each agent has its own cap: a noisy one does not silence another.
      expect(yield* s.allow(base, 2, "a2")).toBe(true);
      expect(yield* s.allow(t("2026-11-15T01:00:01Z"), 2, "a1")).toBe(true);
    }),
  );
});

test("a webhook trigger is never due by the clock and does not hold the alarm", async () => {
  await go(
    Effect.gen(function* () {
      const s = yield* Automations;
      const hook = yield* s.create(
        { kind: "webhook" },
        say("deploy done?"),
        t("2026-11-15T00:00:00Z"),
      );
      expect(yield* s.nextAt).toBeUndefined();
      expect(yield* s.claim(t("2100-01-01T00:00:00Z"))).toEqual([]);
      const once = yield* s.create(
        { kind: "once", at: "2026-11-15T10:00:00Z" },
        say("x"),
        t("2026-11-15T00:00:00Z"),
      );
      expect(yield* s.nextAt).toBe(once.nextAt);
      expect((yield* s.get(hook.id))?.action).toEqual(say("deploy done?"));
    }),
  );
});
