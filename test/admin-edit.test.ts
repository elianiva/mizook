import { Arbitrary, Effect, Layer, Schema } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vite-plus/test";
import { edit } from "../src/admin/edit.ts";
import { checkProfile, Host, type Profile } from "../src/host.ts";
import { Intents } from "../src/intents.ts";
import { Policies } from "../src/policies.ts";
import { Skills } from "../src/skills.ts";
import { fakeHost } from "./fake-host.ts";
import { property } from "./property.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));

const oneOf = <const A extends ReadonlyArray<unknown>>(values: A): Arbitrary.Arbitrary<A[number]> =>
  Arbitrary.map(int(0, values.length - 1), (k) => values[k]);

const maybe = <A>(arbitrary: Arbitrary.Arbitrary<A>) =>
  Arbitrary.flatMap(int(0, 3), (k) => (k === 0 ? Arbitrary.Constant(undefined) : arbitrary));

const pad = oneOf(["", " ", "  ", "\t", "\n "]);

const padded = (text: Arbitrary.Arbitrary<string>) =>
  Arbitrary.map(Arbitrary.all([pad, text, pad]), ([before, core, after]) => ({
    raw: `${before}${core}${after}`,
    trimmed: core,
  }));

const visible = Arbitrary.map(
  Arbitrary.all({
    edge: oneOf(["a", "Z", "é", "日", "🙂", "%", "."]),
    inner: Arbitrary.array(oneOf(["a", "b", " ", "é", "日", "-", "_"]), { maxLength: 10 }),
  }),
  ({ edge, inner }) => `${edge}${inner.join("")}${inner.length > 0 ? edge : ""}`,
);

const sized = (limit: number) =>
  Arbitrary.flatMap(int(0, 2), (k) =>
    k === 0 ? Arbitrary.map(oneOf([limit - 1, limit, limit + 1]), (n) => "w".repeat(n)) : visible,
  );

const world = (profile: { current: Profile }) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  const host = fakeHost({
    profile: Effect.sync(() => profile.current),
    updateProfile: (about, rules) =>
      checkProfile(about, rules).pipe(
        Effect.map((change) => {
          profile.current = {
            about: change.about ?? profile.current.about,
            rules: change.rules ?? profile.current.rules,
          };
          return profile.current;
        }),
      ),
  });
  return Layer.mergeAll(
    Skills.layer(sql),
    Intents.layer(sql),
    Policies.layer(sql),
    Layer.succeed(Host, host),
  );
};

const KINDS = ["profile", "skills", "intents", "policies"] as const;

property(
  "an unknown kind of edit is refused and changes nothing",
  Arbitrary.all({
    kind: Arbitrary.schema(Schema.String).pipe(
      Arbitrary.filter((k) => !(KINDS as ReadonlyArray<string>).includes(k)),
    ),
    input: oneOf([{}, { action: "save", name: "x" }, null, "x"]),
  }),
  ({ kind, input }) => {
    const profile = { current: { about: "kept", rules: ["kept"] } };
    return Effect.gen(function* () {
      expect(yield* edit(kind, input)).toEqual({ ok: false, error: "Unknown thing to edit." });
      expect(yield* (yield* Skills).list).toEqual([]);
      expect(yield* (yield* Intents).list).toEqual([]);
      expect(yield* (yield* Policies).list).toEqual([]);
      expect(profile.current).toEqual({ about: "kept", rules: ["kept"] });
    }).pipe(Effect.provide(world(profile)));
  },
  { runs: 30 },
);

const WRONG_FIELDS: Record<(typeof KINDS)[number], ReadonlyArray<object>> = {
  profile: [{ about: 1 }, { rules: "one rule" }, { rules: [1] }, { about: null }],
  skills: [{ action: "bogus" }, { name: 5 }, { pinned: "yes" }, { body: [] }],
  intents: [{ action: "delete" }, { triggers: "launch" }, { id: "1" }, { expires: "tomorrow" }],
  policies: [{ decision: "maybe" }, { match: ["x"] }, { action: "delete" }, { id: null }],
};

const malformed = Arbitrary.flatMap(oneOf(KINDS), (kind) =>
  Arbitrary.all({
    kind: Arbitrary.Constant(kind),
    input: Arbitrary.flatMap(int(0, 1), (k) =>
      k === 0
        ? oneOf<ReadonlyArray<unknown>>(["not an object", 7, null, true, undefined])
        : oneOf<ReadonlyArray<unknown>>(WRONG_FIELDS[kind]),
    ),
  }),
);

property(
  "input of the wrong shape for its kind is a bad request and changes nothing",
  malformed,
  ({ kind, input }) => {
    const profile = { current: { about: "kept", rules: [] } };
    return Effect.gen(function* () {
      expect(yield* edit(kind, input)).toEqual({ ok: false, error: "Bad request." });
      expect(yield* (yield* Skills).list).toEqual([]);
      expect(yield* (yield* Intents).list).toEqual([]);
      expect(yield* (yield* Policies).list).toEqual([]);
      expect(profile.current.about).toBe("kept");
    }).pipe(Effect.provide(world(profile)));
  },
  { runs: 40 },
);

const skillName = Arbitrary.flatMap(int(0, 4), (k) =>
  k === 0
    ? Arbitrary.map(
        oneOf(["Weekly", "-lead", "has space", "a_b", "é", "x".repeat(65), "a.b"]),
        (name) => ({ name, valid: false }),
      )
    : Arbitrary.map(
        Arbitrary.schema(Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/))),
        (name) => ({ name, valid: true }),
      ),
);

property(
  "a skill saves trimmed exactly when its name, description and body are within limits",
  Arbitrary.all({
    name: Arbitrary.flatMap(skillName, (n) =>
      Arbitrary.map(pad, (p) => ({ ...n, raw: `${p}${n.name}${p}` })),
    ),
    description: Arbitrary.flatMap(int(0, 5), (k) =>
      k === 0 ? Arbitrary.map(pad, (p) => ({ raw: p, trimmed: "" })) : padded(sized(200)),
    ),
    body: Arbitrary.flatMap(int(0, 5), (k) =>
      k === 0 ? Arbitrary.map(pad, (p) => ({ raw: p, trimmed: "" })) : padded(sized(24_000)),
    ),
    pinned: maybe(oneOf([true, false])),
  }),
  ({ name, description, body, pinned }) => {
    const profile = { current: { about: "", rules: [] } };
    const fits =
      name.valid &&
      description.trimmed !== "" &&
      description.trimmed.length <= 200 &&
      body.trimmed !== "" &&
      body.trimmed.length <= 24_000;
    return Effect.gen(function* () {
      const outcome = yield* edit("skills", {
        action: "save",
        name: name.raw,
        description: description.raw,
        body: body.raw,
        ...(pinned !== undefined && { pinned }),
      });
      expect(outcome.ok).toBe(fits);
      const stored = yield* (yield* Skills).list;
      if (!fits) {
        expect(stored).toEqual([]);
        return;
      }
      expect(outcome).toEqual({ ok: true, said: `Saved skill "${name.name}".` });
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        name: name.name,
        description: description.trimmed,
        body: body.trimmed,
        pinned: pinned === true,
      });
    }).pipe(Effect.provide(world(profile)));
  },
  { runs: 60 },
);

const validSkill = Arbitrary.all({
  name: Arbitrary.schema(Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,20}$/))),
  description: visible,
  body: visible,
  pinned: oneOf([true, false]),
});

property(
  "a pinned skill cannot be deleted or unpinned from the dashboard until its pin is lifted, and a missing skill cannot be deleted",
  Arbitrary.all({ skill: validSkill, other: validSkill }),
  ({ skill, other }) => {
    const profile = { current: { about: "", rules: [] } };
    return Effect.gen(function* () {
      const skills = yield* Skills;
      expect((yield* edit("skills", { action: "save", ...skill })).ok).toBe(true);
      if (skill.pinned) {
        expect((yield* edit("skills", { action: "delete", name: skill.name })).ok).toBe(false);
        expect(
          (yield* edit("skills", { ...skill, description: other.description, pinned: false })).ok,
        ).toBe(false);
        expect(yield* skills.get(skill.name)).toMatchObject({
          description: skill.description,
          pinned: true,
        });
        yield* skills.setPinned(skill.name, false);
      }
      expect(yield* edit("skills", { action: "delete", name: ` ${skill.name} ` })).toEqual({
        ok: true,
        said: `Deleted skill "${skill.name}".`,
      });
      expect(yield* skills.get(skill.name)).toBeUndefined();
      expect(yield* edit("skills", { action: "delete", name: skill.name })).toEqual({
        ok: false,
        error: `No skill "${skill.name}".`,
      });
      expect((yield* edit("skills", { action: "delete", name: "  " })).ok).toBe(false);
      if (other.name !== skill.name)
        expect((yield* edit("skills", { action: "delete", name: other.name })).ok).toBe(false);
    }).pipe(Effect.provide(world(profile)));
  },
  { runs: 40 },
);

const triggerList = Arbitrary.array(
  Arbitrary.flatMap(int(0, 5), (k) =>
    k === 0
      ? Arbitrary.map(pad, (p) => ({ raw: p, trimmed: "" }))
      : padded(
          Arbitrary.flatMap(int(0, 3), (j) =>
            j === 0 ? Arbitrary.map(oneOf([63, 64, 65]), (n) => "t".repeat(n)) : visible,
          ),
        ),
  ),
  { maxLength: 4 },
);

const intentInput = Arbitrary.all({
  description: Arbitrary.flatMap(int(0, 6), (k) =>
    k === 0 ? Arbitrary.map(pad, (p) => ({ raw: p, trimmed: "" })) : padded(sized(500)),
  ),
  triggers: Arbitrary.flatMap(int(0, 5), (k) =>
    k === 0
      ? Arbitrary.map(oneOf([8, 9]), (n) =>
          Array.from({ length: n }, (_, j) => ({ raw: ` t${j}`, trimmed: `t${j}` })),
        )
      : triggerList,
  ),
  expiresIn: Arbitrary.flatMap(int(0, 4), (k) =>
    k === 0
      ? oneOf([0, -1000, -DAY, 1.5 * DAY + 0.5])
      : Arbitrary.map(int(1, 400), (days) => days * DAY),
  ),
  maxFires: Arbitrary.flatMap(int(0, 4), (k) =>
    k === 0 ? oneOf([0, 1001, 1.5, -3]) : oneOf([1, 2, 999, 1000]),
  ),
  cooldownHours: Arbitrary.flatMap(int(0, 4), (k) =>
    k === 0 ? oneOf([-0.5, 8760.5, -1]) : oneOf([0, 0.25, 1, 1.7, 8760, 1 / 3]),
  ),
});

type IntentCase = typeof intentInput extends Arbitrary.Arbitrary<infer A> ? A : never;

const accepted = (c: IntentCase) => {
  const triggers = c.triggers.map((t) => t.trimmed).filter((t) => t !== "");
  return (
    c.description.trimmed !== "" &&
    c.description.trimmed.length <= 500 &&
    triggers.length >= 1 &&
    triggers.length <= 8 &&
    triggers.every((t) => t.length <= 64) &&
    c.expiresIn > 0 &&
    Number.isInteger(c.expiresIn) &&
    Number.isInteger(c.maxFires) &&
    c.maxFires >= 1 &&
    c.maxFires <= 1000 &&
    c.cooldownHours >= 0 &&
    c.cooldownHours <= 8760
  );
};

const intentRequest = (c: IntentCase, now: number, id?: number) => ({
  action: "save",
  ...(id !== undefined && { id }),
  description: c.description.raw,
  triggers: c.triggers.map((t) => t.raw),
  expires: now + c.expiresIn,
  maxFires: c.maxFires,
  cooldownHours: c.cooldownHours,
});

const storedIntent = (c: IntentCase, now: number) => ({
  description: c.description.trimmed,
  triggers: c.triggers.map((t) => t.trimmed).filter((t) => t !== ""),
  expires: now + c.expiresIn,
  maxFires: c.maxFires,
  cooldown: Math.round(c.cooldownHours * HOUR),
});

property(
  "an intent is armed exactly when its description, triggers, expiry, fire count and cooldown are within limits, and an edit replaces those fields",
  Arbitrary.all({ first: intentInput, second: intentInput }),
  ({ first, second }) => {
    const profile = { current: { about: "", rules: [] } };
    const now = Date.now();
    return Effect.gen(function* () {
      const intents = yield* Intents;
      const made = yield* edit("intents", intentRequest(first, now));
      expect(made.ok).toBe(accepted(first));
      const list = yield* intents.list;
      if (!accepted(first)) {
        expect(list).toEqual([]);
        return;
      }
      expect(list).toHaveLength(1);
      const id = list[0]!.id;
      expect(made).toEqual({ ok: true, said: `Standing intent #${id} armed.` });
      expect(list[0]).toMatchObject({ ...storedIntent(first, now), state: "armed", fireCount: 0 });

      const changed = yield* edit("intents", intentRequest(second, now, id));
      expect(changed.ok).toBe(accepted(second));
      expect((yield* intents.list)[0]).toMatchObject(
        accepted(second) ? storedIntent(second, now) : storedIntent(first, now),
      );
      if (accepted(second))
        expect((yield* edit("intents", intentRequest(second, now, id + 1))).ok).toBe(false);
    }).pipe(Effect.provide(world(profile)));
  },
  { runs: 60 },
);

property(
  "cancelling an armed intent works once, and an id that is missing, not a whole positive number or unknown is refused",
  Arbitrary.all({
    count: int(1, 4),
    pick: int(0, 3),
    bad: oneOf([undefined, 0, -1, 1.5, 99]),
  }),
  ({ count, pick, bad }) => {
    const profile = { current: { about: "", rules: [] } };
    const now = Date.now();
    return Effect.gen(function* () {
      const intents = yield* Intents;
      for (let k = 0; k < count; k++)
        yield* edit("intents", {
          description: `intent ${k}`,
          triggers: ["launch"],
          expires: now + DAY,
          maxFires: 1,
          cooldownHours: 0,
        });
      const ids = (yield* intents.list).map((i) => i.id);
      const target = ids[pick % ids.length]!;
      expect(yield* edit("intents", { action: "cancel", id: target })).toEqual({
        ok: true,
        said: `Cancelled intent #${target}.`,
      });
      expect((yield* edit("intents", { action: "cancel", id: target })).ok).toBe(false);
      expect(
        (yield* edit("intents", { action: "cancel", ...(bad !== undefined && { id: bad }) })).ok,
      ).toBe(false);
      expect((yield* intents.list).map((i) => [i.id, i.state])).toEqual(
        ids.map((id) => [id, id === target ? "cancelled" : "armed"]),
      );
    }).pipe(Effect.provide(world(profile)));
  },
  { runs: 30 },
);

type Rule = { id: number; match: string; decision: "allow" | "ask" | "deny" };

const policyMatch = Arbitrary.flatMap(int(0, 5), (k) =>
  k === 0
    ? oneOf(["", "   ", "m".repeat(200), "m".repeat(201), ` ${"m".repeat(200)} `])
    : Arbitrary.map(
        Arbitrary.all([pad, oneOf(["Gmail.Send", "gmail.send", "WEB", "web", "Ünï", "日本"]), pad]),
        (parts) => parts.join(""),
      ),
);

const policyStep = Arbitrary.flatMap(oneOf(["add", "update", "remove"]), (op) =>
  Arbitrary.all({
    op: Arbitrary.Constant(op),
    match: policyMatch,
    decision: maybe(oneOf(["allow", "ask", "deny"] as const)),
    id: Arbitrary.flatMap(int(0, 5), (k) => (k === 0 ? oneOf([0, -1, 1.5]) : int(1, 4))),
  }),
);

property(
  "policy edits behave like a list of unique lowercase rules with ids never reused, and the strictest matching rule decides",
  Arbitrary.all({
    steps: Arbitrary.array(policyStep, { maxLength: 24 }),
    target: oneOf(["call Gmail.Send now", "fetch web page", "Ünï日本", "nothing here"]),
  }),
  ({ steps, target }) => {
    const profile = { current: { about: "", rules: [] } };
    return Effect.gen(function* () {
      const policies = yield* Policies;
      let model: Rule[] = [];
      let highestIdSeen = 0;
      for (const step of steps) {
        const match = step.match.trim().toLowerCase();
        const decision = step.decision ?? "ask";
        const validMatch = match !== "" && match.length <= 200;
        const validId = Number.isInteger(step.id) && step.id >= 1;
        const exists = model.some((r) => r.id === step.id);
        if (step.op === "remove") {
          const outcome = yield* edit("policies", { action: "remove", id: step.id });
          expect(outcome.ok).toBe(validId && exists);
          model = model.filter((r) => r.id !== step.id);
        } else if (step.op === "add") {
          const outcome = yield* edit("policies", {
            match: step.match,
            ...(step.decision !== undefined && { decision: step.decision }),
          });
          expect(outcome.ok).toBe(validMatch);
          if (validMatch && !model.some((r) => r.match === match && r.decision === decision)) {
            const added = (yield* policies.list).find(
              (r) => r.match === match && r.decision === decision,
            );
            expect(added?.id).toBeGreaterThan(highestIdSeen);
            highestIdSeen = added?.id ?? highestIdSeen;
            model.push({ id: highestIdSeen, match, decision });
          }
        } else {
          const outcome = yield* edit("policies", {
            action: "save",
            id: step.id,
            match: step.match,
            ...(step.decision !== undefined && { decision: step.decision }),
          });
          const duplicate = model.some(
            (r) => r.id !== step.id && r.match === match && r.decision === decision,
          );
          const ok = validMatch && validId && exists && !duplicate;
          expect(outcome.ok).toBe(ok);
          if (ok) model = model.map((r) => (r.id === step.id ? { ...r, match, decision } : r));
        }
        expect(yield* policies.list).toEqual(model);
      }
      const hits = model.filter((r) => target.toLowerCase().includes(r.match));
      const strictest = (["deny", "ask", "allow"] as const).find((d) =>
        hits.some((r) => r.decision === d),
      );
      expect(yield* policies.decide(target)).toBe(strictest);
    }).pipe(Effect.provide(world(profile)));
  },
  { runs: 60 },
);

const rule = Arbitrary.flatMap(int(0, 5), (k) =>
  k === 0 ? Arbitrary.map(pad, (p) => ({ raw: p, trimmed: "" })) : padded(sized(500)),
);

property(
  "a profile saves its trimmed text and non-blank trimmed rules exactly when within limits, and otherwise keeps the old one",
  Arbitrary.all({
    about: maybe(padded(sized(4000))),
    rules: maybe(
      Arbitrary.flatMap(int(0, 2), (k) =>
        k === 0
          ? Arbitrary.map(oneOf([19, 20, 21]), (n) =>
              Array.from({ length: n }, (_, j) => ({ raw: ` r${j} `, trimmed: `r${j}` })),
            )
          : Arbitrary.array(rule, { maxLength: 6 }),
      ),
    ),
  }),
  ({ about, rules }) => {
    const before = { about: "old", rules: ["old rule"] };
    const profile = { current: before };
    const text = about?.trimmed ?? "";
    const kept = (rules ?? []).map((r) => r.trimmed).filter((r) => r !== "");
    const fits = text.length <= 4000 && kept.length <= 20 && kept.every((r) => r.length <= 500);
    return Effect.gen(function* () {
      const outcome = yield* edit("profile", {
        ...(about !== undefined && { about: about.raw }),
        ...(rules !== undefined && { rules: rules.map((r) => r.raw) }),
      });
      if (!fits) {
        expect(outcome.ok).toBe(false);
        expect(profile.current).toBe(before);
        return;
      }
      expect(outcome).toEqual({
        ok: true,
        said: `Profile saved with ${kept.length} ${kept.length === 1 ? "rule" : "rules"}.`,
      });
      expect(profile.current).toEqual({ about: text, rules: kept });
    }).pipe(Effect.provide(world(profile)));
  },
  { runs: 60 },
);
