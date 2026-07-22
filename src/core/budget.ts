import { Duration, Effect, Result } from "effect";
import { finishToolTiming, startToolTiming, type ToolTiming } from "./timing";

export type SettleResult<A> =
  | {
      readonly ok: true;
      readonly value: A;
      readonly timing: ToolTiming & { readonly durationMs: number };
      readonly timedOut: false;
      readonly failed: false;
    }
  | {
      readonly ok: false;
      readonly value: null;
      readonly timing: ToolTiming & { readonly durationMs: number };
      readonly timedOut: true;
      readonly failed: false;
    }
  | {
      readonly ok: false;
      readonly value: null;
      readonly timing: ToolTiming & { readonly durationMs: number };
      readonly timedOut: false;
      readonly failed: true;
      readonly error: unknown;
    };

/**
 * Run an effect with a time budget. Returns a structured result instead of
 * throwing on timeout or failure. Use for non-critical operations that
 * should not block the main response path.
 */
export const settleWithBudget = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  budgetMs: number,
): Effect.Effect<SettleResult<A>, never, R> =>
  Effect.gen(function* () {
    const timing = yield* startToolTiming;
    const result = yield* Effect.result(Effect.timeout(effect, Duration.millis(budgetMs)));
    const timingFinished = yield* finishToolTiming(timing);
    const timed = timingFinished as ToolTiming & { readonly durationMs: number };

    if (Result.isSuccess(result)) {
      return {
        ok: true as const,
        value: result.success,
        timing: timed,
        timedOut: false,
        failed: false,
      };
    }

    if (isTimeoutException(result.failure)) {
      return { ok: false as const, value: null, timing: timed, timedOut: true, failed: false };
    }

    return {
      ok: false as const,
      value: null,
      timing: timed,
      timedOut: false,
      failed: true,
      error: result.failure,
    };
  });

const isTimeoutException = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error as { _tag: string })._tag === "TimeoutException";
