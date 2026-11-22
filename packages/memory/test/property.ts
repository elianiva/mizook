import { Arbitrary, Data, Effect } from "effect";
import { test } from "vite-plus/test";

type Outcome = void | boolean;

class FailedAssertion extends Data.TaggedError("FailedAssertion")<{ readonly cause: unknown }> {
  override get message() {
    return String(this.cause);
  }
}
type Property<A> = (value: A) => Outcome | Promise<Outcome> | Effect.Effect<Outcome, unknown>;

const asEffect = (outcome: ReturnType<Property<never>>): Effect.Effect<Outcome, unknown> => {
  if (outcome instanceof Promise) {
    return Effect.tryPromise({
      try: () => outcome,
      catch: (cause) => new FailedAssertion({ cause }),
    });
  }
  if (outcome === undefined || typeof outcome === "boolean") return Effect.succeed(outcome);
  return outcome;
};

const holds =
  <A>(property: Property<A>) =>
  (value: A) =>
    Effect.suspend(() => asEffect(property(value))).pipe(
      Effect.map((outcome) => outcome !== false),
      Effect.catchDefect((failedAssertion) => Effect.fail(failedAssertion)),
    );

export const checkProperty = async <A>(
  arbitrary: Arbitrary.Arbitrary<A>,
  property: Property<A>,
  options?: Arbitrary.CheckOptions,
) => {
  const result = await Effect.runPromise(
    Arbitrary.checkEffect(arbitrary, holds(property), { runs: 100, ...options }),
  );
  const report = Arbitrary.formatCheckFailure(result);
  if (report !== undefined) throw new Error(report);
};

export const property = <A>(
  name: string,
  arbitrary: Arbitrary.Arbitrary<A>,
  check: Property<A>,
  options?: Arbitrary.CheckOptions,
) => test(name, () => checkProperty(arbitrary, check, options));
