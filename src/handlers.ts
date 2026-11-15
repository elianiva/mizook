import type { Static } from "@earendil-works/pi-ai";
import { Memory } from "@mizook/memory";
import { Context, DateTime, Effect, Layer } from "effect";
import { Settings } from "./config.ts";
import { ScheduleError } from "./errors.ts";
import { formatDate } from "./format.ts";
import { Schedules, type Schedule } from "./schedules.ts";
import type { Spec } from "./schedule.ts";
import {
  dateParameters,
  scheduleCancelParameters,
  scheduleCreateParameters,
  zoomParameters,
} from "./tools.ts";

/** What a tool does, by name. The arguments were already checked against the tool's schema. */
export class Handlers extends Context.Service<
  Handlers,
  { call(name: string, args: Record<string, unknown>): Effect.Effect<string> }
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

      const specOf = (a: Static<typeof scheduleCreateParameters>): Spec | string => {
        switch (a.kind) {
          case "once":
            return a.at ? { kind: "once", at: a.at } : "once needs `at`";
          case "cron":
            return a.cron ? { kind: "cron", expr: a.cron, timezone } : "cron needs `cron`";
          case "watch":
            return a.url && a.every_minutes
              ? { kind: "watch", url: a.url, everyMinutes: a.every_minutes }
              : "watch needs `url` and `every_minutes`";
          default:
            return `unknown kind ${String(a.kind)}`;
        }
      };

      const run = (name: string, args: Record<string, unknown>): Effect.Effect<string, unknown> => {
        switch (name) {
          case "zoom": {
            const a = args as Static<typeof zoomParameters>;
            return memory.zoom(a.id, a.n);
          }
          case "date":
            return memory.date((args as Static<typeof dateParameters>).id);
          case "schedule_create":
            return Effect.gen(function* () {
              const spec = specOf(args as Static<typeof scheduleCreateParameters>);
              if (typeof spec === "string") return yield* new ScheduleError({ reason: spec });
              const now = new Date(DateTime.toEpochMillis(yield* DateTime.now));
              const made = yield* schedules.create(
                spec,
                (args as Static<typeof scheduleCreateParameters>).prompt,
                now,
              );
              return `Scheduled. ${describe(made)}`;
            });
          case "schedule_list":
            return Effect.map(schedules.list, (all) =>
              all.length === 0 ? "No schedules." : all.map(describe).join("\n"),
            );
          case "schedule_cancel": {
            const id = (args as Static<typeof scheduleCancelParameters>).id;
            return Effect.map(schedules.cancel(id), (done) =>
              done ? `Cancelled #${id}.` : `No active schedule #${id}.`,
            );
          }
          default:
            return Effect.succeed(`No tool ${name}.`);
        }
      };

      // A failure becomes text the agent reads and can act on; it never fails the turn.
      return Handlers.of({
        call: (name, args) =>
          run(name, args).pipe(
            Effect.catch((error) =>
              Effect.succeed(`Error: ${error instanceof Error ? error.message : String(error)}`),
            ),
          ),
      });
    }),
  );
}
