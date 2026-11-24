import { Arbitrary, Effect, Exit, Layer, Schema } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vite-plus/test";
import { Sql } from "../src/sql.ts";
import { Intents, matchesTrigger, type Intent, type IntentState } from "../src/intents.ts";
import { property } from "./property.ts";

const withIntents = <A, E>(f: (db: DatabaseSync) => Effect.Effect<A, E, Intents>) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  return f(db).pipe(Effect.provide(Intents.layer.pipe(Layer.provide(Sql.layer(sql)))));
};

const HOUR = 3_600_000;

const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));

const TRIGGERS = [
  "launch",
  "rollback",
  "plan",
  "發布",
  "roll back",
  "c++",
  "Ünïcode",
  " plan ",
  "",
] as const;

const PIECES = [
  ...TRIGGERS,
  "relaunch",
  "Launch",
  "LAUNCH",
  "planning",
  "明天發布",
  "roll",
  "back",
  "c",
  "ünïcode",
  "x",
] as const;

const SEPARATORS = [" ", "", ",", ".", "-", "_", "\n", "é", "1"] as const;

const message = Arbitrary.array(
  Arbitrary.all({
    piece: Arbitrary.schema(Schema.Literals(PIECES)),
    sep: Arbitrary.schema(Schema.Literals(SEPARATORS)),
  }),
  { maxLength: 6 },
).pipe(Arbitrary.map((parts) => parts.map((p) => p.piece + p.sep).join("")));

const trigger = Arbitrary.schema(Schema.Literals(TRIGGERS));

const LETTER_OR_DIGIT_AT_END = /[\p{L}\p{N}]$/u;
const LETTER_OR_DIGIT_AT_START = /^[\p{L}\p{N}]/u;
const HAS_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const referenceMatch = (text: string, rawTrigger: string) => {
  const needle = rawTrigger.normalize("NFC").toLowerCase().trim();
  const haystack = text.normalize("NFC").toLowerCase();
  if (needle === "") return false;
  if (HAS_CJK.test(needle)) return haystack.includes(needle);
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack.slice(0, at);
    const after = haystack.slice(at + needle.length);
    const beforeOk = !LETTER_OR_DIGIT_AT_END.test(before);
    const afterOk = !LETTER_OR_DIGIT_AT_START.test(after);
    if (beforeOk && afterOk) return true;
  }
  return false;
};

property(
  "a trigger matches when it appears as whole words ignoring case, and a CJK trigger matches as a substring",
  Arbitrary.all({ text: message, trigger }),
  ({ text, trigger }) => matchesTrigger(text, trigger) === referenceMatch(text, trigger),
  { runs: 300 },
);

property(
  "a trigger glued to a letter or digit on either side does not match, and the same word set off by spaces does",
  Arbitrary.all({
    word: Arbitrary.schema(Schema.Literals(["launch", "rollback", "roll back", "c++", "ünïcode"])),
    glue: Arbitrary.schema(Schema.Literals(["a", "Z", "7", "é", "ß"])),
    side: Arbitrary.schema(Schema.Literals(["before", "after"])),
  }),
  ({ word, glue, side }) => {
    const glued = side === "before" ? `${glue}${word}` : `${word}${glue}`;
    expect(matchesTrigger(`x ${glued} y`, word)).toBe(false);
    expect(matchesTrigger(`x ${glue} ${word} ${glue} y`, word)).toBe(true);
  },
);

type Modeled = Omit<Intent, "created">;

const cleanTriggers = (triggers: ReadonlyArray<string>) =>
  triggers.map((t) => t.trim()).filter((t) => t !== "");

/** What `create` and `update` accept: words to act on, a trigger, and an expiry still ahead. */
const acceptable = (description: string, triggers: ReadonlyArray<string>, expires: number) =>
  description.trim() !== "" && cleanTriggers(triggers).length > 0 && expires > Date.now();

const stripCreated = (intent: Intent): Modeled =>
  Object.fromEntries(Object.entries(intent).filter(([key]) => key !== "created")) as Modeled;

const step = Arbitrary.all({
  op: Arbitrary.schema(Schema.Literals(["create", "cancel", "update", "match", "match"])),
  advanceHours: int(0, 3),
  description: message,
  triggers: Arbitrary.array(trigger, { minLength: 1, maxLength: 3 }),
  expiresInHours: int(-2, 12),
  cooldownHours: int(0, 3),
  maxFires: int(1, 3),
  slot: int(0, 5),
  text: message,
});

property(
  "after any run of creates, cancels, updates and messages, the intents and what fires match a model with expiry, cooldown and a fire budget",
  Arbitrary.array(step, { maxLength: 14 }),
  (steps) =>
    withIntents(() =>
      Effect.gen(function* () {
        const intents = yield* Intents;
        const base = Date.now();
        let clock = base;
        let model: Modeled[] = [];
        const idAt = (slot: number) => model[slot]?.id ?? 10_000 + slot;
        for (const s of steps) {
          clock += s.advanceHours * HOUR;
          switch (s.op) {
            case "create": {
              const expires = clock + s.expiresInHours * HOUR;
              const accepted = acceptable(s.description, s.triggers, expires);
              const exit = yield* Effect.exit(
                intents.create(s.description, s.triggers, {
                  expiresAt: expires,
                  cooldownMs: s.cooldownHours * HOUR,
                  maxFires: s.maxFires,
                }),
              );
              expect(Exit.isSuccess(exit)).toBe(accepted);
              if (!Exit.isSuccess(exit)) break;
              const made = exit.value;
              expect(model.map((m) => m.id)).not.toContain(made.id);
              model = [
                ...model,
                {
                  id: made.id,
                  description: s.description.trim(),
                  triggers: cleanTriggers(s.triggers),
                  expires,
                  cooldown: s.cooldownHours * HOUR,
                  maxFires: s.maxFires,
                  fireCount: 0,
                  lastFired: undefined,
                  state: "armed",
                },
              ];
              break;
            }
            case "cancel": {
              const id = idAt(s.slot);
              const armed = model.some((m) => m.id === id && m.state === "armed");
              expect(yield* intents.cancel(id)).toBe(armed);
              model = model.map((m) => (m.id === id && armed ? { ...m, state: "cancelled" } : m));
              break;
            }
            case "update": {
              const id = idAt(s.slot);
              const expires = clock + s.expiresInHours * HOUR + HOUR / 2;
              const accepted = acceptable(s.description, s.triggers, expires);
              const exit = yield* Effect.exit(
                intents.update(id, {
                  description: s.description,
                  triggers: s.triggers,
                  expires,
                  cooldown: s.cooldownHours * HOUR,
                  maxFires: s.maxFires,
                }),
              );
              expect(Exit.isSuccess(exit)).toBe(accepted);
              if (!Exit.isSuccess(exit)) break;
              const changed = exit.value;
              const old = model.find((m) => m.id === id);
              if (old === undefined) {
                expect(changed).toBeUndefined();
                break;
              }
              const state: IntentState =
                old.state === "cancelled"
                  ? "cancelled"
                  : old.fireCount >= s.maxFires
                    ? "done"
                    : expires < base
                      ? "expired"
                      : "armed";
              const next: Modeled = {
                ...old,
                description: s.description.trim(),
                triggers: cleanTriggers(s.triggers),
                expires,
                cooldown: s.cooldownHours * HOUR,
                maxFires: s.maxFires,
                state,
              };
              expect(stripCreated(changed!)).toEqual(next);
              model = model.map((m) => (m.id === id ? next : m));
              break;
            }
            case "match": {
              const fired: Modeled[] = [];
              model = model.map((m) => {
                if (m.state === "armed" && m.expires < clock) return { ...m, state: "expired" };
                if (m.state !== "armed") return m;
                if (m.lastFired !== undefined && clock - m.lastFired < m.cooldown) return m;
                if (!m.triggers.every((t) => referenceMatch(s.text, t))) return m;
                const fireCount = m.fireCount + 1;
                const next: Modeled = {
                  ...m,
                  fireCount,
                  lastFired: clock,
                  state: fireCount >= m.maxFires ? "done" : "armed",
                };
                fired.push(next);
                return next;
              });
              const got = yield* intents.match(s.text, new Date(clock));
              expect(got.map(stripCreated)).toEqual(fired);
              break;
            }
          }
          expect((yield* intents.list).map(stripCreated)).toEqual(model);
        }
      }),
    ),
  { runs: 60 },
);

property(
  "a restored intent reads back with every field it was given",
  Arbitrary.all({
    description: Arbitrary.schema(Schema.String).pipe(
      Arbitrary.filter((value) => !/\p{Cs}/u.test(value)),
    ),
    triggers: Arbitrary.array(
      Arbitrary.schema(Schema.String).pipe(Arbitrary.filter((value) => !/\p{Cs}/u.test(value))),
      { maxLength: 8 },
    ),
    created: int(0, 4_000_000_000_000),
    expires: int(0, 4_000_000_000_000),
    cooldown: int(0, 1_000_000_000),
    maxFires: int(1, 100),
    fireCount: int(0, 100),
    lastFired: Arbitrary.all({
      set: Arbitrary.schema(Schema.Boolean),
      at: int(0, 4_000_000_000_000),
    }).pipe(Arbitrary.map(({ set, at }) => (set ? at : undefined))),
    state: Arbitrary.schema(Schema.Literals(["armed", "done", "cancelled", "expired"])),
  }),
  (input) =>
    withIntents(() =>
      Effect.gen(function* () {
        const intents = yield* Intents;
        const restored = yield* intents.restore(input);
        expect(restored).toEqual({ id: restored.id, ...input });
        expect(yield* intents.list).toEqual([restored]);
      }),
    ),
  { runs: 40 },
);

property(
  "an intent whose stored triggers are a JSON list of strings fires only when every one of them is mentioned",
  Arbitrary.all({
    triggers: Arbitrary.array(trigger, { minLength: 1, maxLength: 3 }),
    pretty: Arbitrary.schema(Schema.Boolean),
    text: message,
  }),
  ({ triggers, pretty, text }) =>
    withIntents((db) =>
      Effect.gen(function* () {
        const intents = yield* Intents;
        const now = Date.now();
        const made = yield* intents.create("Stored by hand.", ["placeholder"], {
          expiresAt: now + HOUR,
          cooldownMs: 0,
          maxFires: 1,
        });
        const stored = pretty ? JSON.stringify(triggers, null, 2) : JSON.stringify(triggers);
        db.prepare("UPDATE app_intents SET triggers = ? WHERE id = ?").run(stored, made.id);
        const fired = yield* intents.match(text, new Date(now));
        expect(fired.length === 1).toBe(triggers.every((t) => referenceMatch(text, t)));
      }),
    ),
  { runs: 40 },
);

property(
  "an intent with no readable trigger never fires, whatever the message",
  Arbitrary.all({
    stored: Arbitrary.schema(
      Schema.Literals(["{oops", "", "null", "{}", "[]", "[1,2]", "[null]", '"launch"', "launch"]),
    ),
    text: Arbitrary.flatMap(Arbitrary.schema(Schema.Boolean), (plain) =>
      plain ? Arbitrary.Constant("launch {oops null") : message,
    ),
  }),
  ({ stored, text }) =>
    withIntents((db) =>
      Effect.gen(function* () {
        const intents = yield* Intents;
        const now = Date.now();
        const options = { expiresAt: now + HOUR, cooldownMs: 0, maxFires: 1 };
        const corrupted = yield* intents.create("Stored by hand.", ["placeholder"], options);
        db.prepare("UPDATE app_intents SET triggers = ? WHERE id = ?").run(stored, corrupted.id);
        yield* intents.restore({
          description: "Restored with no triggers.",
          triggers: [],
          created: now,
          expires: now + HOUR,
          cooldown: 0,
          maxFires: 1,
          fireCount: 0,
          lastFired: undefined,
          state: "armed",
        });
        expect(yield* intents.match(text, new Date(now))).toEqual([]);
      }),
    ),
  { runs: 40 },
);
