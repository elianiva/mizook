import { Arbitrary, Effect, Schema } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vite-plus/test";
import { Skills } from "../src/skills.ts";
import { property } from "./property.ts";

const withSkills = <A, E>(effect: Effect.Effect<A, E, Skills>) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  return effect.pipe(Effect.provide(Skills.layer(sql)));
};

const text = Arbitrary.schema(Schema.String).pipe(
  Arbitrary.filter((value) => !/\p{Cs}/u.test(value)),
);

const NAMES = ["weekly-review", "a", "b0", "zz-top", "weekly", "0-start"] as const;

const step = Arbitrary.all({
  op: Arbitrary.schema(
    Schema.Literals(["save", "touch", "pin", "unpin", "setPinned", "remove", "get"]),
  ),
  name: Arbitrary.schema(Schema.Literals(NAMES)),
  description: text,
  body: text,
});

interface Model {
  description: string;
  body: string;
  useCount: number;
  used: boolean;
  pinned: boolean;
}

property(
  "after any run of saves, reads, pins and deletes, each skill matches a model and the list and index are sorted by name",
  Arbitrary.array(step, { maxLength: 16 }),
  (steps) =>
    withSkills(
      Effect.gen(function* () {
        const skills = yield* Skills;
        const model = new Map<string, Model>();
        for (const s of steps) {
          const current = model.get(s.name);
          switch (s.op) {
            case "save": {
              const saved = yield* skills.save(s.name, s.description, s.body);
              const next = current
                ? { ...current, description: s.description, body: s.body }
                : {
                    description: s.description,
                    body: s.body,
                    useCount: 0,
                    used: false,
                    pinned: false,
                  };
              model.set(s.name, next);
              expect(saved).toMatchObject({
                name: s.name,
                description: s.description,
                body: s.body,
                useCount: next.useCount,
                pinned: next.pinned,
              });
              break;
            }
            case "touch":
              yield* skills.touch(s.name);
              if (current)
                model.set(s.name, { ...current, useCount: current.useCount + 1, used: true });
              break;
            case "pin":
              yield* skills.pin(s.name);
              if (current) model.set(s.name, { ...current, pinned: true });
              break;
            case "unpin":
            case "setPinned": {
              const pinned = s.op === "setPinned";
              yield* skills.setPinned(s.name, pinned);
              if (current) model.set(s.name, { ...current, pinned });
              break;
            }
            case "remove":
              expect(yield* skills.remove(s.name)).toBe(current !== undefined);
              model.delete(s.name);
              break;
            case "get":
              break;
          }
          const read = yield* skills.get(s.name);
          const expected = model.get(s.name);
          if (expected === undefined) {
            expect(read).toBeUndefined();
          } else {
            expect(read).toMatchObject({
              name: s.name,
              description: expected.description,
              body: expected.body,
              useCount: expected.useCount,
              pinned: expected.pinned,
            });
            expect(read?.usedAt === undefined).toBe(!expected.used);
            expect(read!.updated).toBeGreaterThanOrEqual(read!.created);
          }
        }
        const names = [...model.keys()].sort();
        expect((yield* skills.list).map((skill) => skill.name)).toEqual(names);
        expect(yield* skills.index).toEqual(
          names.map((name) => ({ name, description: model.get(name)!.description })),
        );
      }),
    ),
  { runs: 50 },
);
