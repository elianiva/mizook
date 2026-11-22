import { DurableObject } from "cloudflare:workers";
import type { SqlDriver } from "@mizook/memory/sqlite";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ConfigProvider, Effect, Layer, ManagedRuntime } from "effect";
import { Automations, type Automation } from "./automations.ts";
import { Settings } from "./config.ts";
import type { Env } from "./env.ts";
import { ActionError } from "./errors.ts";
import { hookToken } from "./hooks.ts";
import { Runner, Targets } from "./runner.ts";
import { Runs, type Run } from "./runs.ts";
import type { Action, Spec } from "./schedule.ts";
import { Web } from "./search.ts";

/** What an agent's Durable Object does for an automation. */
interface AgentTarget {
  runTurn(place: string, text: string, requestId: string): Promise<string>;
  postTo(place: string, text: string): Promise<void>;
}

/** The outcome of a write, for a tool or the dashboard to read. */
export type AutomationChange = { ok: true; automation: Automation } | { ok: false; error: string };

/**
 * Every automation, for every agent: the triggers, the alarm that fires them, and their runs. An
 * agent creates and manages them through RPC; the action reaches the agent it names.
 */
export class AutomationsObject extends DurableObject<Env> {
  private readonly runtime;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql: SqlDriver = {
      all: <T>(query: string, ...params: unknown[]) =>
        ctx.storage.sql.exec(query, ...(params as never[])).toArray() as T[],
    };
    /** Move the alarm earlier, never later. */
    const arm = async (at: number) => {
      const current = await ctx.storage.getAlarm();
      if (current === null || at < current) await ctx.storage.setAlarm(at);
    };
    const agent = (id: string) =>
      env.AgentObject.getByName(`agent:${id}`) as unknown as AgentTarget;
    const hub = () =>
      env.Hub.getByName("hub") as unknown as { agent(key: string): Promise<unknown> };
    const failed = (what: string) => (cause: unknown) =>
      new ActionError({
        reason: `${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    const targets = Targets.of({
      agentExists: (id) =>
        Effect.tryPromise(() => hub().agent(id)).pipe(
          Effect.map((found) => found !== undefined),
          Effect.orElseSucceed(() => false),
        ),
      turn: (id, place, text, requestId) =>
        Effect.tryPromise({
          try: () => agent(id).runTurn(place, text, requestId),
          catch: failed("the turn failed"),
        }),
      post: (id, place, text) =>
        Effect.tryPromise({
          try: () => agent(id).postTo(place, text),
          catch: failed("posting failed"),
        }),
      call: (url, method, body) =>
        Effect.tryPromise({
          try: async () => {
            const response = await fetch(url, {
              method,
              ...(body !== undefined &&
                method !== "GET" && {
                  body,
                  headers: { "content-type": "application/json" },
                }),
            });
            const text = await response.text();
            if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 300)}`);
            return `${response.status} ${text.slice(0, 2_000)}`;
          },
          catch: failed(`${method} ${url} failed`),
        }),
    });
    // The watch trigger fetches pages the way web_fetch does.
    const vars = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
    const settings = Settings.layer.pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(vars))),
    );
    this.runtime = ManagedRuntime.make(
      Runner.layer.pipe(
        Layer.provideMerge(Layer.merge(Automations.layer(sql, arm), Runs.layer(sql))),
        Layer.provide(Layer.succeed(Targets, targets)),
        Layer.provide(Web.layer.pipe(Layer.provide(Layer.merge(settings, FetchHttpClient.layer)))),
      ),
    );
  }

  private run<A, E>(effect: Effect.Effect<A, E, Runner | Automations | Runs>): Promise<A> {
    return this.runtime.runPromise(effect);
  }

  /** Set the alarm to the soonest clock trigger, or clear it. */
  private async rearm(): Promise<void> {
    const next = await this.run(Automations.use((a) => a.nextAt));
    if (next === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  override async alarm(): Promise<void> {
    await this.run(Runner.use((r) => r.wake)).catch((error) =>
      console.error("automations failed", error),
    );
    await this.rearm();
  }

  async create(spec: Spec, action: Action): Promise<AutomationChange> {
    return this.run(
      Runner.use((r) => r.create(spec, action)).pipe(
        Effect.match({
          onSuccess: (automation) => ({ ok: true as const, automation }),
          onFailure: (error) => ({ ok: false as const, error: error.message }),
        }),
      ),
    );
  }

  /** The link that fires a webhook trigger. The token is an HMAC, so nothing is stored. */
  async hookUrl(id: number): Promise<string> {
    const token = await hookToken(this.env.MIZOOK_WEBHOOK_SECRET, `auto:${id}`);
    return `${this.env.PUBLIC_URL ?? ""}/hook/${id}/${token}`;
  }

  /** Every automation, active and paused; with `agent`, only those whose action is for it. */
  async list(agent?: string): Promise<ReadonlyArray<Automation>> {
    const all = await this.run(Automations.use((a) => a.all));
    return agent === undefined
      ? all
      : all.filter((a) => a.action.kind !== "webhook" && a.action.agent === agent);
  }

  async get(id: number): Promise<Automation | undefined> {
    return this.run(Automations.use((a) => a.get(id)));
  }

  async cancel(id: number): Promise<boolean> {
    const done = await this.run(Automations.use((a) => a.cancel(id)));
    await this.rearm();
    return done;
  }

  async pause(id: number): Promise<boolean> {
    const done = await this.run(Automations.use((a) => a.pause(id)));
    await this.rearm();
    return done;
  }

  async resume(id: number): Promise<{ ok: boolean; error?: string }> {
    return this.run(
      Automations.use((a) => a.resume(id, new Date())).pipe(
        Effect.match({
          onSuccess: (ok) => ({ ok }),
          onFailure: (error) => ({ ok: false, error: error.message }),
        }),
      ),
    );
  }

  /** Fire one now in the background. False when there is no such automation. */
  async test(id: number): Promise<boolean> {
    if (!(await this.get(id))) return false;
    this.ctx.waitUntil(
      this.run(Runner.use((r) => r.test(id))).catch((error) =>
        console.error(`test of #${id} failed`, error),
      ),
    );
    return true;
  }

  /** A call to a webhook trigger's link, already checked by the Worker. */
  async hook(id: number, body: string): Promise<boolean> {
    const a = await this.get(id);
    if (!a || !a.active || a.spec.kind !== "webhook") return false;
    // The action can take minutes; the caller gets its answer at once.
    this.ctx.waitUntil(
      this.run(Runner.use((r) => r.hook(id, body))).catch((error) =>
        console.error(`webhook #${id} failed`, error),
      ),
    );
    return true;
  }

  async runs(limit: number, automationId?: number): Promise<ReadonlyArray<Run>> {
    return this.run(
      Runs.use((r) => r.list({ limit, ...(automationId === undefined ? {} : { automationId }) })),
    );
  }
}
