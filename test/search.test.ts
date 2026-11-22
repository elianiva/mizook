import { Arbitrary, Effect, Exit, Schema } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expect } from "vite-plus/test";
import { WebError } from "../src/errors.ts";
import { searchWith, type SearchProvider, type SearchResult } from "../src/search.ts";
import { property } from "./property.ts";

const text = Arbitrary.schema(Schema.String.check(Schema.isMaxLength(20)));

const result = Arbitrary.all({ title: text, url: text, snippet: text });

const plan = Arbitrary.all({
  answers: Arbitrary.schema(Schema.Boolean),
  results: Arbitrary.array(result, { maxLength: 4 }),
  key: text,
});

interface Plan {
  readonly answers: boolean;
  readonly results: ReadonlyArray<SearchResult>;
  readonly key: string;
}

interface Call {
  readonly provider: number;
  readonly query: string;
  readonly limit: number;
  readonly key: string;
}

const providersFor = (plans: ReadonlyArray<Plan>, calls: Call[]) =>
  plans.map((plan, index) => {
    const provider: SearchProvider = {
      name: `provider-${index}`,
      search: (query, limit, key) =>
        Effect.suspend(() => {
          calls.push({ provider: index, query, limit, key });
          return plan.answers
            ? Effect.succeed(plan.results)
            : Effect.fail(new WebError({ url: provider.name, reason: "rate limited" }));
        }),
    };
    return { provider, key: plan.key };
  });

const search = Arbitrary.all({
  plans: Arbitrary.array(plan, { maxLength: 6 }),
  query: text,
  limit: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
});

const run = (plans: ReadonlyArray<Plan>, query: string, limit: number, calls: Call[]) =>
  Effect.exit(searchWith(providersFor(plans, calls), query, limit)).pipe(
    Effect.provide(FetchHttpClient.layer),
  );

property(
  "the answer is the results of the first provider that answers, and with none answering the search fails",
  search,
  ({ plans, query, limit }) =>
    Effect.gen(function* () {
      const exit = yield* run(plans, query, limit, []);
      const first = plans.find((plan) => plan.answers);
      if (first === undefined) expect(Exit.isFailure(exit)).toBe(true);
      else expect(exit).toEqual(Exit.succeed(first.results));
    }),
);

property(
  "providers are tried in order, each with the query, the limit and its own key, and none after the first that answers",
  search,
  ({ plans, query, limit }) =>
    Effect.gen(function* () {
      const calls: Call[] = [];
      yield* run(plans, query, limit, calls);
      const firstAnswering = plans.findIndex((plan) => plan.answers);
      const tried = firstAnswering === -1 ? plans : plans.slice(0, firstAnswering + 1);
      expect(calls).toEqual(
        tried.map((plan, provider) => ({ provider, query, limit, key: plan.key })),
      );
    }),
);

property(
  "putting failing providers in front does not change the answer",
  Arbitrary.all({ search, failing: Arbitrary.array(plan, { maxLength: 4 }) }),
  ({ search: { plans, query, limit }, failing }) =>
    Effect.gen(function* () {
      const broken = failing.map((plan) => ({ ...plan, answers: false }));
      const before = yield* run(plans, query, limit, []);
      const after = yield* run([...broken, ...plans], query, limit, []);
      expect(Exit.isSuccess(after)).toBe(Exit.isSuccess(before));
      if (Exit.isSuccess(before)) expect(after).toEqual(before);
    }),
);
