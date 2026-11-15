import { Memory } from "@mizook/memory";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { Settings } from "./config.ts";
import { ScheduleError } from "./errors.ts";
import { formatDate } from "./format.ts";
import { Schedules, type Schedule } from "./schedules.ts";
import type { Spec } from "./schedule.ts";
import { DateArgs, ScheduleCancelArgs, ScheduleCreateArgs, ZoomArgs } from "./tools.ts";

/** What a tool does, by name. The arguments were already checked against the tool's schema. */
export class Handlers extends Context.Service<
  Handlers,
  { call(name: string, args: unknown): Effect.Effect<string> }
>()("mizook/Handlers") {
  static readonly layer = Layer.effect(
    Handlers,
    Effect.gen(function* () {
      const memory = yield* Memory;
      const schedules = yield* Schedules;
      const { timezone } = yield* Settings;

      const describe = (s: Schedule) => {
        const { spec } = s;
        const what =
          spec.kind === "once"
            ? `once at ${spec.at}`
            : spec.kind === "cron"
              ? `cron "${spec.expr}" (${spec.timezone})`
              : `watch ${spec.url} every ${spec.everyMinutes} min`;
        return `#${s.id} ${what}; next ${formatDate(new Date(s.nextAt), timezone)}; ${s.prompt}`;
      };

      const specOf = (a: typeof ScheduleCreateArgs.Type): Effect.Effect<Spec, ScheduleError> => {
        const missing = (what: string) => Effect.fail(new ScheduleError({ reason: what }));
        switch (a.kind) {
          case "once":
            return a.at ? Effect.succeed({ kind: "once", at: a.at }) : missing("once needs `at`");
          case "cron":
            return a.cron
              ? Effect.succeed({ kind: "cron", expr: a.cron, timezone })
              : missing("cron needs `cron`");
          case "watch":
            return a.url && a.every_minutes
              ? Effect.succeed({ kind: "watch", url: a.url, everyMinutes: a.every_minutes })
              : missing("watch needs `url` and `every_minutes`");
        }
      };

      const decode = <S extends Schema.Decoder<unknown>>(schema: S, args: unknown) =>
        Schema.decodeUnknownEffect(schema)(args);

      const run = (
        name: string,
        args: unknown,
      ): Effect.Effect<string, { readonly message: string }> => {
        switch (name) {
          case "zoom":
            return Effect.flatMap(decode(ZoomArgs, args), (a) => memory.zoom(a.id, a.n));
          case "date":
            return Effect.flatMap(decode(DateArgs, args), (a) => memory.date(a.id));
          case "schedule_create":
            return Effect.gen(function* () {
              const a = yield* decode(ScheduleCreateArgs, args);
              const spec = yield* specOf(a);
              const now = new Date(DateTime.toEpochMillis(yield* DateTime.now));
              return `Scheduled. ${describe(yield* schedules.create(spec, a.prompt, now))}`;
            });
          case "schedule_list":
            return Effect.map(schedules.list, (all) =>
              all.length === 0 ? "No schedules." : all.map(describe).join("\n"),
            );
          case "schedule_cancel":
            return Effect.flatMap(decode(ScheduleCancelArgs, args), ({ id }) =>
              Effect.map(schedules.cancel(id), (done) =>
                done ? `Cancelled #${id}.` : `No active schedule #${id}.`,
              ),
            );
          default:
            return Effect.succeed(`No tool ${name}.`);
        }
      };

      // A failure becomes text the agent reads and can act on; it never fails the turn.
      return Handlers.of({
        call: (name, args) =>
          run(name, args).pipe(Effect.catch((error) => Effect.succeed(`Error: ${error.message}`))),
      });
    }),
  );
}
