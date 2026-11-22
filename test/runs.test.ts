import { Arbitrary, Effect, Schema } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vite-plus/test";
import { Runs, type RunStatus } from "../src/runs.ts";
import { property } from "./property.ts";

const go = <A, E>(effect: Effect.Effect<A, E, Runs>) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  return Effect.provide(effect, Runs.layer(sql));
};

const survivesUtf8 = (s: string) => new TextDecoder().decode(new TextEncoder().encode(s)) === s;
const text = Arbitrary.schema(Schema.String).pipe(Arbitrary.filter(survivesUtf8));

const step = Arbitrary.all({
  automationId: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 }))),
  finished: Arbitrary.schema(Schema.Boolean),
  status: Arbitrary.schema(Schema.Literals(["succeeded", "failed", "skipped"])),
  output: text,
  error: Arbitrary.schema(Schema.Boolean).pipe(
    Arbitrary.flatMap((has) =>
      has ? Arbitrary.map(text, (e): string | undefined => e) : Arbitrary.Constant(undefined),
    ),
  ),
});

const scenario = Arbitrary.all({
  steps: Arbitrary.array(step, { maxLength: 12 }),
  limit: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 14 }))),
  filterBy: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
});

property(
  "listed runs are the newest first, cut at the limit, filtered by automation, with what each finish recorded",
  scenario,
  ({ steps, limit, filterBy }) =>
    go(
      Effect.gen(function* () {
        const runs = yield* Runs;
        const model: Array<{
          id: number;
          automationId: number;
          status: RunStatus;
          output: string;
          error: string | undefined;
          finished: boolean;
        }> = [];
        for (const s of steps) {
          const id = yield* runs.start(s.automationId);
          model.push({
            id,
            automationId: s.automationId,
            status: "running",
            output: "",
            error: undefined,
            finished: false,
          });
        }
        for (const [index, s] of steps.entries()) {
          if (!s.finished) continue;
          const run = model[index]!;
          yield* runs.finish(run.id, s.status, s.output, s.error);
          Object.assign(run, {
            status: s.status,
            output: s.output,
            error: s.error,
            finished: true,
          });
        }
        const newestFirst = [...model].reverse();
        const expectRuns = (listed: ReadonlyArray<unknown>, expected: typeof model) => {
          expect(listed).toHaveLength(expected.length);
          expected.forEach((run, i) => {
            const got = listed[i] as Record<string, unknown>;
            expect(got).toMatchObject({
              id: run.id,
              automationId: run.automationId,
              status: run.status,
              output: run.output,
              error: run.error,
            });
            expect(typeof got.finished).toBe(run.finished ? "number" : "undefined");
          });
        };
        expect(new Set(model.map((r) => r.id)).size).toBe(model.length);
        expectRuns(yield* runs.list({ limit }), newestFirst.slice(0, limit));
        expectRuns(
          yield* runs.list({ limit, automationId: filterBy }),
          newestFirst.filter((r) => r.automationId === filterBy).slice(0, limit),
        );
      }),
    ),
  { runs: 40 },
);
