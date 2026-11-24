import { Arbitrary, Effect, Exit, Layer, Schema } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vite-plus/test";
import { Sql } from "../src/sql.ts";
import { Policies, type Decision, type Policy } from "../src/policies.ts";
import { property } from "./property.ts";

const withPolicies = <A, E>(effect: Effect.Effect<A, E, Policies>) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  return effect.pipe(Effect.provide(Policies.layer.pipe(Layer.provide(Sql.layer(sql)))));
};

const WORDS = ["gmail", "gmail.send", "send", "delete", "calendar.list", "list", ""] as const;

const match = Arbitrary.schema(Schema.Literals(WORDS));
const decision = Arbitrary.schema(Schema.Literals(["allow", "ask", "deny"]));
const slot = Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 })));

const target = Arbitrary.array(
  Arbitrary.all({
    word: Arbitrary.schema(
      Schema.Literals([...WORDS, "call", "email", "file", "Gmail.Send", "DELETE"]),
    ),
    sep: Arbitrary.schema(Schema.Literals([" ", ".", "", "_"])),
  }),
  { maxLength: 4 },
).pipe(Arbitrary.map((parts) => parts.map((p) => p.word + p.sep).join("")));

const step = Arbitrary.all({
  op: Arbitrary.schema(Schema.Literals(["add", "update", "remove", "decide"])),
  match,
  decision,
  slot,
  target,
});

const RANK: Record<Decision, number> = { allow: 1, ask: 2, deny: 3 };

const referenceDecision = (rules: ReadonlyArray<Policy>, target: string) =>
  rules
    .filter((r) => r.match !== "" && target.toLowerCase().includes(r.match))
    .map((r) => r.decision)
    .reduce<Decision | undefined>(
      (best, d) => (best === undefined || RANK[d] > RANK[best] ? d : best),
      undefined,
    );

property(
  "after any run of adds, updates and removes, the rules match a model and decide picks deny over ask over allow among the matching rules",
  Arbitrary.array(step, { maxLength: 16 }),
  (steps) =>
    withPolicies(
      Effect.gen(function* () {
        const policies = yield* Policies;
        let rules: Policy[] = [];
        const everSeen: number[] = [];
        const idAt = (slot: number) => rules[slot]?.id ?? 10_000 + slot;
        for (const s of steps) {
          switch (s.op) {
            case "add": {
              const same = rules.find((r) => r.match === s.match && r.decision === s.decision);
              const exit = yield* Effect.exit(policies.add(s.match, s.decision));
              expect(Exit.isSuccess(exit)).toBe(s.match !== "");
              if (!Exit.isSuccess(exit)) break;
              const made = exit.value;
              expect(made).toMatchObject({ match: s.match, decision: s.decision });
              if (same) {
                expect(made.id).toBe(same.id);
              } else {
                expect(everSeen).not.toContain(made.id);
                everSeen.push(made.id);
                rules = [...rules, made];
              }
              break;
            }
            case "update": {
              const id = idAt(s.slot);
              const exists = rules.some((r) => r.id === id);
              const clash = rules.some(
                (r) => r.id !== id && r.match === s.match && r.decision === s.decision,
              );
              const exit = yield* Effect.exit(policies.update(id, s.match, s.decision));
              if (s.match === "" || (exists && clash)) {
                expect(Exit.isFailure(exit)).toBe(true);
              } else if (exists) {
                const changed = { id, match: s.match, decision: s.decision };
                expect(exit).toEqual(Exit.succeed(changed));
                rules = rules.map((r) => (r.id === id ? changed : r));
              } else {
                expect(exit).toEqual(Exit.succeed(undefined));
              }
              break;
            }
            case "remove": {
              const id = idAt(s.slot);
              const exists = rules.some((r) => r.id === id);
              expect(yield* policies.remove(id)).toBe(exists);
              rules = rules.filter((r) => r.id !== id);
              break;
            }
            case "decide":
              expect(yield* policies.decide(s.target)).toBe(referenceDecision(rules, s.target));
          }
          expect(yield* policies.list).toEqual(rules);
        }
      }),
    ),
  { runs: 60 },
);
