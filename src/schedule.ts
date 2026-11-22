import { Cron } from "croner";
import { Effect, Schema } from "effect";
import { ScheduleError } from "./errors.ts";

export const MIN_WATCH_MINUTES = 5;

export const Spec = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("once"), at: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("cron"), expr: Schema.String, timezone: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("watch"),
    url: Schema.String,
    everyMinutes: Schema.Finite,
  }),
  Schema.Struct({ kind: Schema.Literal("webhook") }),
]);
export type Spec = typeof Spec.Type;

export const SpecJson = Schema.fromJsonString(Spec);

export const Action = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("turn"),
    agent: Schema.String,
    place: Schema.String,
    prompt: Schema.String,
    skill: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("post"),
    agent: Schema.String,
    place: Schema.String,
    text: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("webhook"),
    url: Schema.String,
    method: Schema.Literals(["GET", "POST", "PUT"]),
    body: Schema.optionalKey(Schema.String),
  }),
]);
export type Action = typeof Action.Type;

export const ActionJson = Schema.fromJsonString(Action);

export const NEVER = 8_640_000_000_000_000;

const fail = (reason: string) => Effect.fail(new ScheduleError({ reason }));

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
    case "webhook":
      return Effect.succeed(new Date(NEVER));
  }
};

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
