import { Arbitrary, Effect, Exit, Schema } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vite-plus/test";
import { Automations } from "../src/automations.ts";
import { Action, type Spec } from "../src/schedule.ts";
import { property } from "./property.ts";

const go = <A, E>(f: Effect.Effect<A, E, Automations>) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  return Effect.provide(f, Automations.layer(sql));
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FROM = Date.UTC(2026, 0, 1);
const TO = Date.UTC(2030, 0, 1);

const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));
const oneOf = <const A extends ReadonlyArray<string | number>>(values: A) =>
  Arbitrary.schema(Schema.Literals(values));
const choose = <A>(...options: ReadonlyArray<Arbitrary.Arbitrary<A>>) =>
  int(0, options.length - 1).pipe(Arbitrary.flatMap((i) => options[i]!));

const instant = int(FROM, TO);
const t = (ms: number) => new Date(ms);
const say = (prompt: string): Action => ({ kind: "turn", agent: "a1", place: "", prompt });
const everyTen = { kind: "cron", expr: "*/10 * * * *", timezone: "UTC" } as const;
const nextTenMinuteSlot = (after: number) => (Math.floor(after / (10 * MINUTE)) + 1) * 10 * MINUTE;

property(
  "a once is not claimed before its time, is claimed once at or after it, and is then finished",
  Arbitrary.all({
    created: instant,
    lead: choose(Arbitrary.Constant(1), int(1, 30 * DAY)),
    early: choose(Arbitrary.Constant(1), int(1, 30 * DAY)),
    late: choose(Arbitrary.Constant(0), int(0, 30 * DAY)),
    again: int(0, 30 * DAY),
  }),
  ({ created, lead, early, late, again }) =>
    go(
      Effect.gen(function* () {
        const s = yield* Automations;
        const at = created + lead;
        const made = yield* s.create(
          { kind: "once", at: t(at).toISOString() },
          say("call mum"),
          t(created),
        );
        expect(made.nextAt).toBe(at);
        expect(yield* s.nextAt).toBe(at);
        expect(yield* s.claim(t(Math.max(created, at - early)))).toEqual([]);
        expect((yield* s.claim(t(at + late))).map((x) => x.id)).toEqual([made.id]);
        expect(yield* s.claim(t(at + late + again))).toEqual([]);
        expect(yield* s.list).toEqual([]);
        expect(yield* s.nextAt).toBeUndefined();
      }),
    ),
  { runs: 40 },
);

property(
  "a once at or before now is refused when created",
  Arbitrary.all({ now: instant, ago: choose(Arbitrary.Constant(0), int(0, 365 * DAY)) }),
  ({ now, ago }) =>
    go(
      Effect.gen(function* () {
        const s = yield* Automations;
        const made = yield* Effect.exit(
          s.create({ kind: "once", at: t(now - ago).toISOString() }, say("x"), t(now)),
        );
        expect(Exit.isFailure(made)).toBe(true);
        expect(yield* s.all).toEqual([]);
      }),
    ),
  { runs: 40 },
);

property(
  "a cron missed for any length of time is claimed once, then waits for the next slot after the wake",
  Arbitrary.all({ created: instant, sleep: int(0, 30 * DAY) }),
  ({ created, sleep }) =>
    go(
      Effect.gen(function* () {
        const s = yield* Automations;
        yield* s.create(everyTen, say("tick"), t(created));
        const woke = created + sleep;
        const firstSlot = nextTenMinuteSlot(created);
        const due = firstSlot <= woke;
        expect(yield* s.claim(t(woke))).toHaveLength(due ? 1 : 0);
        expect(yield* s.claim(t(woke))).toHaveLength(0);
        expect(yield* s.nextAt).toBe(due ? nextTenMinuteSlot(woke) : firstSlot);
      }),
    ),
  { runs: 40 },
);

property(
  "cancelling some automations removes exactly those: each cancel succeeds once and the rest still fire",
  Arbitrary.all({
    created: instant,
    cancelled: Arbitrary.array(Arbitrary.schema(Schema.Boolean), { minLength: 1, maxLength: 6 }),
  }),
  ({ created, cancelled }) =>
    go(
      Effect.gen(function* () {
        const s = yield* Automations;
        const made = [];
        for (const _ of cancelled) made.push(yield* s.create(everyTen, say("tick"), t(created)));
        for (const [i, a] of made.entries()) {
          if (!cancelled[i]) continue;
          expect(yield* s.cancel(a.id)).toBe(true);
          expect(yield* s.cancel(a.id)).toBe(false);
        }
        const kept = made.filter((_, i) => !cancelled[i]).map((a) => a.id);
        expect((yield* s.claim(t(created + DAY))).map((a) => a.id)).toEqual(kept);
        expect((yield* s.all).map((a) => a.id)).toEqual(kept);
      }),
    ),
  { runs: 30 },
);

property(
  "a paused automation is hidden from the active list and never claimed, and resumes at its next slot after the resume",
  Arbitrary.all({ created: instant, pausedFor: int(0, 30 * DAY) }),
  ({ created, pausedFor }) =>
    go(
      Effect.gen(function* () {
        const s = yield* Automations;
        const made = yield* s.create(everyTen, say("tick"), t(created));
        expect(yield* s.pause(made.id)).toBe(true);
        expect(yield* s.pause(made.id)).toBe(false);
        expect(yield* s.list).toEqual([]);
        expect((yield* s.all).map((a) => a.active)).toEqual([false]);
        expect(yield* s.nextAt).toBeUndefined();
        const resumedAt = created + pausedFor;
        expect(yield* s.claim(t(resumedAt))).toEqual([]);
        expect(yield* s.resume(made.id, t(resumedAt))).toBe(true);
        expect((yield* s.list).map((a) => a.id)).toEqual([made.id]);
        expect(yield* s.nextAt).toBe(nextTenMinuteSlot(resumedAt));
        expect(yield* s.resume(made.id + 1, t(resumedAt))).toBe(false);
      }),
    ),
  { runs: 40 },
);

property(
  "a watch reports a change only when a page hash differs from the one before it, never on the first look",
  Arbitrary.array(oneOf(["h1", "h2", "h3"]), { maxLength: 12 }),
  (hashes) =>
    go(
      Effect.gen(function* () {
        const s = yield* Automations;
        const w = yield* s.create(
          { kind: "watch", url: "https://a.b/x", everyMinutes: 10 },
          say("tell me"),
          t(FROM),
        );
        const seen = [];
        for (const hash of hashes) seen.push(yield* s.watchChanged(w.id, hash));
        expect(seen).toEqual(hashes.map((hash, i) => i > 0 && hashes[i - 1] !== hash));
        expect((yield* s.get(w.id))?.lastHash).toBe(hashes.at(-1));
      }),
    ),
  { runs: 40 },
);

property(
  "the hourly limit allows each agent at most its cap of fires in any hour, separately from other agents",
  Arbitrary.all({
    limit: int(1, 4),
    start: instant,
    fires: Arbitrary.array(
      Arbitrary.all({
        gap: choose(oneOf([0, 1, HOUR - 1, HOUR, HOUR + 1]), int(0, 2 * HOUR)),
        key: oneOf(["a1", "a2", "a3"]),
      }),
      { maxLength: 25 },
    ),
  }),
  ({ limit, start, fires }) =>
    go(
      Effect.gen(function* () {
        const s = yield* Automations;
        const accepted: Array<{ at: number; key: string }> = [];
        let now = start;
        for (const { gap, key } of fires) {
          now += gap;
          const inLastHour = accepted.filter((f) => f.key === key && f.at >= now - HOUR).length;
          const expected = inLastHour < limit;
          expect(yield* s.allow(t(now), limit, key)).toBe(expected);
          if (expected) accepted.push({ at: now, key });
        }
      }),
    ),
  { runs: 60 },
);

const clockOrHook = Arbitrary.all({
  hook: Arbitrary.schema(Schema.Boolean),
  lead: int(1, 60 * DAY),
});

property(
  "webhook triggers are never due by the clock: the alarm is the earliest clock automation, and their action is kept as given",
  Arbitrary.all({
    created: instant,
    specs: Arbitrary.array(clockOrHook, { minLength: 1, maxLength: 6 }),
    action: Arbitrary.schema(Action),
  }),
  ({ created, specs, action }) =>
    go(
      Effect.gen(function* () {
        const s = yield* Automations;
        const made = [];
        for (const { hook, lead } of specs) {
          const spec: Spec = hook
            ? { kind: "webhook" }
            : { kind: "once", at: t(created + lead).toISOString() };
          made.push(yield* s.create(spec, action, t(created)));
        }
        const clockTimes = specs.filter((x) => !x.hook).map((x) => created + x.lead);
        expect(yield* s.nextAt).toBe(clockTimes.length === 0 ? undefined : Math.min(...clockTimes));
        const claimed = yield* s.claim(t(created + 61 * DAY));
        const byId = (a: number, b: number) => a - b;
        expect(claimed.map((a) => a.id).sort(byId)).toEqual(
          made.filter((_, i) => !specs[i]!.hook).map((a) => a.id),
        );
        for (const a of made) expect((yield* s.get(a.id))?.action).toEqual(action);
      }),
    ),
  { runs: 40 },
);
