import { Arbitrary, Effect, Schema } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vite-plus/test";
import { Approvals } from "../src/approvals.ts";
import { routeOf } from "../src/route.ts";
import { property } from "./property.ts";

const withApprovals = <A, E>(effect: Effect.Effect<A, E, Approvals>) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  return effect.pipe(Effect.provide(Approvals.layer(sql)));
};

const text = Arbitrary.schema(Schema.String).pipe(
  Arbitrary.filter((value) => !/\p{Cs}/u.test(value)),
);

const place = Arbitrary.schema(
  Schema.Literals(["telegram:-1001:5", "telegram:-1001:6", "telegram:42", "telegram:main"]),
);

const request = Arbitrary.all({
  executionId: text,
  summary: text,
  match: text,
  place,
  action: Arbitrary.all({ given: Arbitrary.schema(Schema.Boolean), value: text }).pipe(
    Arbitrary.map(({ given, value }) => (given ? value : undefined)),
  ),
  posted: Arbitrary.schema(Schema.Boolean),
  taken: Arbitrary.schema(Schema.Boolean),
});

property(
  "each place sees its own unposted, untaken approvals in the order they were asked, and each is taken at most once with what was stored",
  Arbitrary.all({
    requests: Arbitrary.array(request, { maxLength: 10 }),
    order: Arbitrary.array(
      Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9 }))),
      {
        maxLength: 10,
      },
    ),
  }),
  ({ requests, order }) =>
    withApprovals(
      Effect.gen(function* () {
        const approvals = yield* Approvals;
        const made = [];
        for (const r of requests) {
          const added = yield* approvals.add(r.executionId, r.summary, r.match, r.place, r.action);
          expect(added).toMatchObject({
            executionId: r.executionId,
            summary: r.summary,
            match: r.match,
            place: r.place,
            action: r.action ?? "",
          });
          expect(made.map((m) => m.id)).not.toContain(added.id);
          made.push(added);
        }
        for (const [i, r] of requests.entries())
          if (r.posted) yield* approvals.markPosted(made[i]!.id);
        const takenNow = new Set<number>();
        for (const i of order) {
          const target = made[i];
          if (target === undefined || !requests[i]!.taken) continue;
          const taken = yield* approvals.take(target.id);
          if (takenNow.has(i)) {
            expect(taken).toBeUndefined();
          } else {
            expect(taken).toEqual(target);
            takenNow.add(i);
          }
        }
        for (const p of ["telegram:-1001:5", "telegram:-1001:6", "telegram:42", "telegram:main"]) {
          const expected = made
            .filter((_, i) => requests[i]!.place === p && !requests[i]!.posted && !takenNow.has(i))
            .map((m) => m.id);
          expect((yield* approvals.unposted(p)).map((a) => a.id)).toEqual(expected);
        }
      }),
    ),
  { runs: 40 },
);

property(
  "an approval button with an eight-character agent id fits Telegram's 64 bytes inside the Chat SDK wrapper and still names its agent",
  Arbitrary.all({
    verb: Arbitrary.schema(Schema.Literals(["approve", "always", "deny"])),
    agent: Arbitrary.schema(Schema.String.check(Schema.isPattern(/^[a-z0-9]{8}$/))),
    id: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 9_999_999_999 })),
    ),
  }),
  ({ verb, agent, id }) =>
    Effect.gen(function* () {
      const data = `chat:${JSON.stringify({ a: `${verb}:${agent}:${id}` })}`;
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
      const routed = yield* routeOf(JSON.stringify({ callback_query: { data } }));
      expect(routed.agentId).toBe(agent);
    }),
);
