import { Context, Effect } from "effect";
import type { Automation } from "./automations.ts";
import { InvalidInput, type StateError, type ToolError } from "./errors.ts";
import type { Run } from "./runs.ts";
import type { Action, Spec } from "./schedule.ts";
import type { Skills } from "./skills.ts";
import type { Spend } from "./usage.ts";

export interface AgentInfo {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly role: string;
  readonly persona: string;
  readonly tools: ReadonlyArray<string> | undefined;
  readonly doName: string;
  readonly isDefault: boolean;
  readonly bound: ReadonlyArray<string>;
  readonly created: number;
  readonly lastActive: number;
}

export interface AgentSpec {
  readonly slug: string;
  readonly name: string;
  readonly role: string;
  readonly persona: string;
  readonly tools?: ReadonlyArray<string> | null;
}

export type AgentChange = { ok: true; agent: AgentInfo } | { ok: false; error: string };

export interface AutomationsApi {
  create(spec: Spec, action: Action): Effect.Effect<Automation, ToolError>;
  list(agent?: string): Effect.Effect<ReadonlyArray<Automation>>;
  cancel(id: number): Effect.Effect<boolean>;
  pause(id: number): Effect.Effect<boolean>;
  resume(id: number): Effect.Effect<boolean, ToolError>;
  test(id: number): Effect.Effect<boolean>;
  hookUrl(id: number): Effect.Effect<string>;
  runs(limit: number, automationId?: number): Effect.Effect<ReadonlyArray<Run>>;
}

export interface Profile {
  readonly about: string;
  readonly rules: ReadonlyArray<string>;
}

export interface WebThreadInfo {
  readonly id: string;
  readonly agent: AgentInfo;
  readonly title: string;
  readonly preview: string;
  readonly created: number;
  readonly updated: number;
  readonly archived: boolean;
}

export const EMPTY_PROFILE: Profile = { about: "", rules: [] };

const MAX_ABOUT = 4_000;
const MAX_RULES = 20;
const MAX_RULE = 500;

/**
 * A profile change with its about trimmed and blank rules dropped, or the reason it cannot be
 * saved. An undefined part keeps what the profile has.
 */
export const checkProfile = (
  about: string | undefined,
  rules: ReadonlyArray<string> | undefined,
): Effect.Effect<
  { readonly about: string | undefined; readonly rules: ReadonlyArray<string> | undefined },
  InvalidInput
> => {
  const text = about?.trim();
  const kept = rules?.map((rule) => rule.trim()).filter((rule) => rule !== "");
  const refuse = (reason: string) => Effect.fail(new InvalidInput({ reason }));
  if (text !== undefined && text.length > MAX_ABOUT)
    return refuse("Keep the profile under 4,000 characters.");
  if (kept !== undefined && kept.length > MAX_RULES)
    return refuse(`Keep the rules to ${MAX_RULES} or fewer.`);
  if (kept?.some((rule) => rule.length > MAX_RULE))
    return refuse(`Keep each rule under ${MAX_RULE} characters.`);
  return Effect.succeed({ about: text, rules: kept });
};

/** The profile as text, or "" when it is empty. */
export const describeProfile = (profile: Profile): string =>
  [
    profile.about.trim() === "" ? "" : `About: ${profile.about.trim()}`,
    profile.rules.length === 0
      ? ""
      : `Rules:\n${profile.rules.map((rule) => `- ${rule}`).join("\n")}`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");

export class Host extends Context.Service<
  Host,
  {
    readonly self: AgentInfo;
    readonly reload: Effect.Effect<void>;
    readonly agents: Effect.Effect<ReadonlyArray<AgentInfo>>;
    bind(place: string, slug: string | undefined): Effect.Effect<AgentInfo | undefined>;
    placeLabel(place: string): Effect.Effect<string>;
    namePlace(place: string, name: string): Effect.Effect<void>;
    createAgent(spec: AgentSpec): Effect.Effect<AgentChange>;
    updateAgent(key: string, patch: Partial<AgentSpec>): Effect.Effect<AgentChange>;
    deleteAgent(key: string): Effect.Effect<AgentChange>;
    setAgentSetting(doName: string, key: string, value: string): Effect.Effect<void>;
    reloadAgent(doName: string): Effect.Effect<void>;
    readonly globalSkills: Skills["Service"];
    ask(agent: string, question: string): Effect.Effect<string, ToolError>;
    readonly profile: Effect.Effect<Profile>;
    /** Saves the profile through `checkProfile`; an undefined part keeps what it has. */
    updateProfile(
      about: string | undefined,
      rules: ReadonlyArray<string> | undefined,
    ): Effect.Effect<Profile, StateError | InvalidInput>;
    readonly automations: AutomationsApi;
    readonly spendAll: Effect.Effect<
      ReadonlyArray<{ readonly name: string; readonly spend: Spend }>
    >;
    readonly exportNow: Effect.Effect<string>;
  }
>()("mizook/Host") {}

export const shortPlace = (place: string): string => {
  const [, chat, topic] = /^telegram:(-?\d+)(?::(\d+))?$/.exec(place) ?? [];
  if (chat === undefined) return place;
  if (topic !== undefined) return `topic ${topic}`;
  return chat.startsWith("-") ? "group" : "DM";
};
