import { Cron } from "croner";
import { Effect, Schema } from "effect";
import { ScheduleError } from "./errors.ts";

/** The shortest gap between two polls of a watch. */
export const MIN_WATCH_MINUTES = 5;

/** When something should wake the chat. Stored as JSON, so the schema is also the row format. */
export const Spec = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("once"), at: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("cron"), expr: Schema.String, timezone: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("watch"),
    url: Schema.String,
    everyMinutes: Schema.Finite,
  }),
]);
export type Spec = typeof Spec.Type;

export const SpecJson = Schema.fromJsonString(Spec);

const fail = (reason: string) => Effect.fail(new ScheduleError({ reason }));

/**
 * The first time after `after` that `spec` fires, or `undefined` when it never fires again (a
 * `once` in the past). A cron missed during downtime fires once when the chat wakes: the caller
 * asks for the next time after *now*, not after the missed one. Fails with the reason when the
 * spec cannot be used.
 */
export const nextFire = (
  spec: Spec,
  after: Date,
): Effect.Effect<Date | undefined, ScheduleError> => {
  switch (spec.kind) {
    case "once": {
      const at = new Date(spec.at);
      if (Number.isNaN(at.getTime())) return fail(`"${spec.at}" is not a date`);
      return Effect.succeed(at.getTime() > after.getTime() ? at : undefined);
    }
    case "cron":
      return Effect.try({
        try: () => new Cron(spec.expr, { timezone: spec.timezone }).nextRun(after) ?? undefined,
        catch: (cause) =>
          new ScheduleError({ reason: cause instanceof Error ? cause.message : String(cause) }),
      });
    case "watch": {
      if (!/^https?:\/\//.test(spec.url)) return fail("a watch needs an http(s) url");
      if (spec.everyMinutes < MIN_WATCH_MINUTES) {
        return fail(`a watch polls at most every ${MIN_WATCH_MINUTES} minutes`);
      }
      return Effect.succeed(new Date(after.getTime() + spec.everyMinutes * 60_000));
    }
  }
};

/** The first fire of a new schedule: fails when the spec is unusable or already in the past. */
export const firstFire = (spec: Spec, now: Date): Effect.Effect<Date, ScheduleError> =>
  nextFire(spec, now).pipe(
    Effect.filterOrFail(
      (at): at is Date => at !== undefined,
      () =>
        new ScheduleError({
          reason: spec.kind === "once" ? `${spec.at} is in the past` : "it never fires",
        }),
    ),
  );
