import { clipToolOutput } from "@mizook/memory";
import { Context, DateTime, Effect, Layer } from "effect";
import { Automations, type Automation } from "./automations.ts";
import { ActionError, type ScheduleError, type StateError } from "./errors.ts";
import { Runs } from "./runs.ts";
import type { Action, Spec } from "./schedule.ts";
import { Web } from "./search.ts";
import { sha256 } from "./web.ts";

/** Most times one agent may be woken by automations in an hour: a bad watch must not flood it. */
export const FIRES_PER_HOUR = 20;

/** What an action reaches outside the automations: the agents, and the web. */
export class Targets extends Context.Service<
  Targets,
  {
    /** Whether the agent with this id exists. */
    agentExists(agent: string): Effect.Effect<boolean>;
    /** A turn of `agent` in `place` (empty: where it talked last). Gives its reply. */
    turn(
      agent: string,
      place: string,
      text: string,
      requestId: string,
    ): Effect.Effect<string, ActionError>;
    /** Post `text` to `place` through `agent`'s bot, with no model call. */
    post(agent: string, place: string, text: string): Effect.Effect<void, ActionError>;
    /** Call an outside URL. Gives the status and the start of the answer. */
    call(url: string, method: string, body: string | undefined): Effect.Effect<string, ActionError>;
  }
>()("mizook/Targets") {}

/** How a fire went, as its run records it. */
export type Fired =
  | { readonly status: "succeeded"; readonly output: string }
  | { readonly status: "skipped"; readonly output: string }
  | { readonly status: "failed"; readonly error: string };

/** One line saying what an automation does, for lists and for the model. */
export const describeAutomation = (
  a: Pick<Automation, "id" | "spec" | "action" | "active" | "nextAt">,
  when: (at: number) => string,
  agentName: (id: string) => string,
): string => {
  const { spec, action } = a;
  const trigger =
    spec.kind === "once"
      ? `once at ${spec.at}`
      : spec.kind === "cron"
        ? `cron "${spec.expr}" (${spec.timezone})`
        : spec.kind === "watch"
          ? `watch ${spec.url} every ${spec.everyMinutes} min`
          : "on its webhook link";
  const place = (p: string) => (p === "" ? "where it talked last" : p);
  const what =
    action.kind === "turn"
      ? `${agentName(action.agent)} in ${place(action.place)}${action.skill ? ` [skill ${action.skill}]` : ""}: ${action.prompt}`
      : action.kind === "post"
        ? `post via ${agentName(action.agent)} to ${place(action.place)}: ${action.text}`
        : `${action.method} ${action.url}`;
  const next = !a.active
    ? "paused"
    : spec.kind === "webhook"
      ? "waiting for a call"
      : `next ${when(a.nextAt)}`;
  return `#${a.id} ${trigger}; ${next}; ${what}`;
};

/**
 * Fires automations: takes what is due, checks a watch's page, holds each agent to its hourly
 * limit, carries out the action, and records the run.
 */
export class Runner extends Context.Service<
  Runner,
  {
    /** Make one, after checking that its agent exists and its spec and URL work. */
    create(
      spec: Spec,
      action: Action,
    ): Effect.Effect<Automation, ScheduleError | StateError | ActionError>;
    /** Fire every automation due now. */
    readonly wake: Effect.Effect<void, StateError>;
    /** A call to an automation's webhook link. Undefined when there is no such active webhook trigger. */
    hook(id: number, body: string): Effect.Effect<Fired | undefined, StateError>;
    /** Fire one now, as a test, whatever its trigger. Its next time stays as it was. */
    test(id: number): Effect.Effect<Fired | undefined, StateError>;
  }
>()("mizook/Runner") {
  static readonly layer = Layer.effect(
    Runner,
    Effect.gen(function* () {
      const automations = yield* Automations;
      const runs = yield* Runs;
      const web = yield* Web;
      const targets = yield* Targets;
      const nowDate = Effect.map(DateTime.now, (n) => new Date(DateTime.toEpochMillis(n)));

      /** What the action gets from its trigger: a watch's new page, a webhook's body. */
      const act = (a: Automation, payload: string | undefined, requestId: string) =>
        Effect.gen(function* () {
          const { action } = a;
          switch (action.kind) {
            case "turn": {
              if (!(yield* automations.allow(yield* nowDate, FIRES_PER_HOUR, action.agent)))
                return {
                  status: "skipped",
                  output: `over ${FIRES_PER_HOUR} fires an hour for this agent`,
                } as const;
              const skill =
                action.skill === undefined ? "" : `Read skill "${action.skill}" first.\n\n`;
              const brought = payload === undefined ? "" : `\n\n${payload}`;
              const reply = yield* targets.turn(
                action.agent,
                action.place,
                `[automation #${a.id}] ${skill}${action.prompt}${brought}`,
                requestId,
              );
              return { status: "succeeded", output: reply } as const;
            }
            case "post":
              yield* targets.post(action.agent, action.place, action.text);
              return { status: "succeeded", output: action.text } as const;
            case "webhook": {
              const escaped = JSON.stringify(payload ?? "").slice(1, -1);
              const body = action.body?.replaceAll("{{payload}}", escaped);
              const answer = yield* targets.call(action.url, action.method, body);
              return { status: "succeeded", output: answer } as const;
            }
          }
        });

      /** Carry out an action and keep the run. A failure is recorded, never thrown. */
      const fire = (a: Automation, payload: string | undefined, requestId: string) =>
        Effect.gen(function* () {
          const runId = yield* runs.start(a.id);
          const fired: Fired = yield* act(a, payload, requestId).pipe(
            Effect.catch((error: ActionError | StateError) =>
              Effect.succeed({ status: "failed", error: error.message } as const),
            ),
          );
          yield* fired.status === "failed"
            ? runs.finish(runId, "failed", "", fired.error.slice(0, 1_000))
            : runs.finish(runId, fired.status, clipToolOutput(fired.output, 4_000));
          return fired;
        });

      /** A watch's page, when it changed since the last look; undefined otherwise. */
      const changedPage = (a: Automation) =>
        Effect.gen(function* () {
          if (a.spec.kind !== "watch") return undefined;
          const url = a.spec.url;
          const page = yield* web.fetch(url).pipe(
            Effect.map((p) => p.text),
            Effect.catch((error) =>
              Effect.logWarning(`watch #${a.id} failed: ${error.message}`).pipe(
                Effect.as(undefined),
              ),
            ),
          );
          if (page === undefined) return undefined;
          const changed = yield* automations.watchChanged(
            a.id,
            yield* Effect.promise(() => sha256(page)),
          );
          return changed ? `${url} changed. It now reads:\n${clipToolOutput(page)}` : undefined;
        });

      const wake = Effect.gen(function* () {
        for (const a of yield* automations.claim(yield* nowDate)) {
          const page = yield* changedPage(a);
          if (a.spec.kind === "watch" && page === undefined) continue;
          yield* fire(a, page, `auto:${a.id}:${a.nextAt}`);
        }
      });

      return Runner.of({
        create: (spec, action) =>
          Effect.gen(function* () {
            if (
              (action.kind === "turn" || action.kind === "post") &&
              !(yield* targets.agentExists(action.agent))
            )
              return yield* new ActionError({ reason: `no agent ${action.agent}` });
            if (action.kind === "webhook" && !action.url.startsWith("https://"))
              return yield* new ActionError({ reason: "a webhook action needs an https url" });
            return yield* automations.create(spec, action, yield* nowDate);
          }),
        wake,
        hook: (id, body) =>
          Effect.gen(function* () {
            const a = yield* automations.get(id);
            if (!a || !a.active || a.spec.kind !== "webhook") return undefined;
            return yield* fire(
              a,
              `The webhook was called with:\n${clipToolOutput(body, 8_000)}`,
              `hook:${id}:${crypto.randomUUID()}`,
            );
          }),
        test: (id) =>
          Effect.gen(function* () {
            const a = yield* automations.get(id);
            if (!a) return undefined;
            return yield* fire(
              a,
              a.spec.kind === "webhook" ? "(a test: no body)" : undefined,
              `test:${id}:${Date.now()}`,
            );
          }),
      });
    }),
  );
}
