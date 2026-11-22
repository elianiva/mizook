// ui-sdk's agent API (`@ui-sdk/core/agent`): `snapshot`, `query` and `act` over every
// component on the page, as the same three tools a model or the browser's WebMCP calls.
// It hears components as their instances are made, so it works on the instances in the
// registry unchanged: an agent's `setValue` reaches our callbacks with the source
// `agent`, goes through the guard, and arrives as `ChangedUiState` like a click.
// `createAgent` must run before the first view renders, so create it at module level.
import { registerTools } from "@ui-sdk/core/agent";
import type { createAgent, ObservedChange } from "@ui-sdk/core/agent";
import type { Stream } from "effect";
import { fromListener } from "./internal/stream.ts";

export { agentTools, createAgent, registerTools } from "@ui-sdk/core/agent";
export type {
  AgentAction,
  AgentChange,
  AgentComponent,
  AgentStep,
  ObservedChange,
} from "@ui-sdk/core/agent";

type Agent = ReturnType<typeof createAgent>;
type Allow = Parameters<typeof registerTools>[1]["allow"];

/**
 * Registers the agent's tools with the browser's agent for as long as the Stream
 * runs, and unregisters them when it ends. Where the browser has no WebMCP it does
 * nothing. It emits no Messages. Return it from a Subscription, so the tools exist
 * while the Model says they should.
 */
export const registerAgentTools = (agent: Agent, options: { allow: Allow }): Stream.Stream<never> =>
  fromListener<never>(() => registerTools(agent, options));

/** A Stream of every change to a component, from a person or an agent. For logs and audit trails. */
export const watchAgent = <A>(
  agent: Agent,
  toMessage: (change: ObservedChange) => A,
): Stream.Stream<A> => fromListener((emit) => agent.subscribe((change) => emit(toMessage(change))));
