import { Context, type Effect } from "effect";
import type { StateError, ToolError } from "./errors.ts";
import type { Skills } from "./skills.ts";
import type { Spend } from "./usage.ts";

/** An agent as the Hub knows it. */
export interface AgentInfo {
  /** Random and stable: the Durable Object is `agent:<id>`, so the slug can change. */
  readonly id: string;
  /** What `/<slug>` invokes and `/agent <slug>` binds. */
  readonly slug: string;
  readonly name: string;
  /** What this agent is for: a prompt that goes after the persona. Empty for a general agent. */
  readonly role: string;
  /** How it talks, in place of the shared persona. Empty: the shared one. */
  readonly persona: string;
  /** The tools it is offered, by name. Undefined: every tool. */
  readonly tools: ReadonlyArray<string> | undefined;
  readonly doName: string;
  readonly isDefault: boolean;
  /** The Telegram places bound to this agent. The default agent also answers every unbound one. */
  readonly bound: ReadonlyArray<string>;
  readonly created: number;
  /** When an update was last routed to it, in epoch milliseconds; 0 for never. */
  readonly lastActive: number;
}

/** What makes an agent, as created or changed. `tools: null` in a change gives it every tool again. */
export interface AgentSpec {
  readonly slug: string;
  readonly name: string;
  readonly role: string;
  readonly persona: string;
  readonly tools?: ReadonlyArray<string> | null;
}

/** A change to the agents, or why it was refused. */
export type AgentChange = { ok: true; agent: AgentInfo } | { ok: false; error: string };

/** What the user is, across every agent: a short profile and the rules they want followed. */
export interface Profile {
  readonly about: string;
  readonly rules: ReadonlyArray<string>;
}

export const EMPTY_PROFILE: Profile = { about: "", rules: [] };

/**
 * What an agent needs from outside itself, which only the Durable Object can give: the Hub and
 * the other agents, and a restart of its own runtime after its settings change.
 */
export class Host extends Context.Service<
  Host,
  {
    /** This agent. */
    readonly self: AgentInfo;
    /** The link other services call to start a turn with this agent. */
    readonly hookUrl: Effect.Effect<string>;
    /** Rebuild this agent's runtime, so new settings take effect. */
    readonly reload: Effect.Effect<void>;
    readonly agents: Effect.Effect<ReadonlyArray<AgentInfo>>;
    /** Make a place use the agent `slug`, or the default agent when undefined. */
    bind(place: string, slug: string | undefined): Effect.Effect<AgentInfo | undefined>;
    /** What the user calls a place, or a short form of its id. */
    placeLabel(place: string): Effect.Effect<string>;
    namePlace(place: string, name: string): Effect.Effect<void>;
    createAgent(spec: AgentSpec): Effect.Effect<AgentChange>;
    updateAgent(key: string, patch: Partial<AgentSpec>): Effect.Effect<AgentChange>;
    deleteAgent(key: string): Effect.Effect<AgentChange>;
    /** Change one setting of another agent, as its slash command would. */
    setAgentSetting(doName: string, key: string, value: string): Effect.Effect<void>;
    /** Make an agent read its config from the Hub again. */
    reloadAgent(doName: string): Effect.Effect<void>;
    /** The skills every agent shares, kept in the Hub. */
    readonly globalSkills: Skills["Service"];
    /** Ask another agent a question, by its slug, read-only. */
    ask(agent: string, question: string): Effect.Effect<string, ToolError>;
    /** What every agent knows about the user. Empty when the Hub cannot answer. */
    readonly profile: Effect.Effect<Profile>;
    /** Change the shared profile. Fields left out keep their value. */
    updateProfile(
      about: string | undefined,
      rules: ReadonlyArray<string> | undefined,
    ): Effect.Effect<Profile, StateError>;
    /** Start one schedule now, in the background. The result goes to the chat. */
    testSchedule(id: number): Effect.Effect<boolean>;
    /** What every agent spent. */
    readonly spendAll: Effect.Effect<
      ReadonlyArray<{ readonly name: string; readonly spend: Spend }>
    >;
    /** Write this agent's archive to the blob store and give the key. */
    readonly exportNow: Effect.Effect<string>;
  }
>()("mizook/Host") {}

/** A place id without its platform prefix, for when the user has not named it. */
export const shortPlace = (place: string): string => {
  const [, chat, topic] = /^telegram:(-?\d+)(?::(\d+))?$/.exec(place) ?? [];
  if (chat === undefined) return place;
  if (topic !== undefined) return `topic ${topic}`;
  return chat.startsWith("-") ? "group" : "DM";
};
