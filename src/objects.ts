import type { AgentObject } from "./agent-object.ts";
import type { AutomationsObject } from "./automations-object.ts";
import type { Env } from "./env.ts";
import type { Hub } from "./hub.ts";

/**
 * A Durable Object's public methods as seen through its stub: each returns a promise of its
 * result. Derived from the class, so callers cannot drift from it. Cloudflare's own stub type
 * splits a union result into a union of promises, which no caller can await as one type.
 */
export type Remote<T> = {
  readonly [K in keyof T as T[K] extends (...args: never) => unknown ? K : never]: T[K] extends (
    ...args: infer A
  ) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/** The Hub: agents, bindings, places, global skills and the profile. One per install. */
export const hubObject = (env: Env) => env.Hub.getByName("hub") as unknown as Remote<Hub>;

/** The Automations object, which runs every agent's automations. One per install. */
export const automationsObject = (env: Env) =>
  env.Automations.getByName("automations") as unknown as Remote<AutomationsObject>;

/** An agent's Durable Object name, from its stable id. */
export const agentDoName = (id: string): string => `agent:${id}`;

/** An agent's Durable Object, by its Durable Object name (`AgentInfo.doName`). */
export const agentObject = (env: Env, doName: string) =>
  env.AgentObject.getByName(doName) as unknown as Remote<AgentObject>;
