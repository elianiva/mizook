import { Effect, Schema } from "effect";
import { describeAgentAction, encodeAgentAction, type AgentAction } from "./agent-manage.ts";
import { Approvals } from "./approvals.ts";
import { ToolError } from "./errors.ts";
import { describeProfile, Host } from "./host.ts";
import { defineTool, described } from "./tool.ts";

export const AskAgentArgs = Schema.Struct({
  agent: described(Schema.String, "The other agent's slug, from agents.manage list."),
  question: described(Schema.String, "What to ask. It answers from its own memory, read-only."),
});

export const AgentManageArgs = Schema.Struct({
  action: described(
    Schema.Literals(["list", "create", "update", "delete"]),
    "list: every agent with its role and tools. create, update and delete ask the user to approve first.",
  ),
  slug: Schema.optionalKey(
    described(
      Schema.String,
      "The agent's command name, such as grok: lowercase letters, digits and _, 2 to 32. Required for create, update and delete.",
    ),
  ),
  new_slug: Schema.optionalKey(described(Schema.String, "update: rename the command.")),
  name: Schema.optionalKey(described(Schema.String, "Display name, up to 64 characters.")),
  role: Schema.optionalKey(
    described(
      Schema.String,
      "What the agent is for and how it works, as instructions to it. Goes after its persona.",
    ),
  ),
  persona: Schema.optionalKey(
    described(
      Schema.String,
      "How it talks, replacing the shared persona. Leave out to keep the shared one; give an empty string to go back to it.",
    ),
  ),
  tools: Schema.optionalKey(
    described(
      Schema.Array(Schema.String),
      'The only tools it gets, by path such as web.search or by namespace such as memory. ["all"] gives every tool. It can always talk to the user.',
    ),
  ),
  model: Schema.optionalKey(described(Schema.String, "Its model id, as /model takes.")),
});

export const ProfileArgs = Schema.Struct({
  action: described(
    Schema.Literals(["get", "update"]),
    "get: read the profile. update: change the fields you give and keep the rest.",
  ),
  about: Schema.optionalKey(
    described(
      Schema.String,
      "update: who the user is, in a few lines. Name, work, language, stable preferences. Empty clears it.",
    ),
  ),
  rules: Schema.optionalKey(
    described(
      Schema.Array(Schema.String),
      "update: standing instructions such as 'ask before sending email' or 'use metric units'. Empty clears them.",
    ),
  ),
});

/** `toolPaths` is read when a call runs, since the list it comes from includes these tools. */
export const agentsTools = (toolPaths: () => ReadonlyArray<string>) => [
  defineTool({
    name: "ask_agent",
    path: "agents.ask",
    description:
      "Ask another of the user's agents a question; it answers from its own memory, read-only.",
    args: AskAgentArgs,
    run: (a) => Host.use((host) => host.ask(a.agent, a.question)),
  }),
  defineTool({
    name: "agent_manage",
    path: "agents.manage",
    description:
      "List the user's agents, or create, change or delete one. An agent is a separate assistant with its own memory, role and tools, which the user talks to with /<slug> or binds to a place with /agent <slug>. Changes need the user's approval.",
    args: AgentManageArgs,
    run: (a, place) =>
      Effect.gen(function* () {
        const host = yield* Host;
        if (a.action === "list") {
          const all = yield* host.agents;
          return all
            .map((agent) =>
              [
                `/${agent.slug} ${agent.name}${agent.isDefault ? " (default)" : ""}${agent.id === host.self.id ? " (you)" : ""}`,
                agent.role === "" ? "" : `  role: ${agent.role.slice(0, 400)}`,
                `  tools: ${agent.tools === undefined ? "all" : agent.tools.join(", ")}`,
              ]
                .filter((line) => line !== "")
                .join("\n"),
            )
            .join("\n");
        }
        const slug = a.slug?.trim().replace(/^\//, "").toLowerCase();
        if (!slug) return yield* new ToolError({ reason: `${a.action} needs a slug` });
        const known = new Set([...toolPaths(), ...toolPaths().map((p) => p.split(".")[0])]);
        const tools =
          a.tools === undefined
            ? undefined
            : a.tools.length === 1 && a.tools[0] === "all"
              ? null
              : a.tools;
        const unknown = tools?.filter((name) => !known.has(name)) ?? [];
        if (unknown.length > 0) {
          return yield* new ToolError({ reason: `no tool ${unknown.join(", ")}` });
        }
        if (a.action === "create" && (yield* host.agents).some((x) => x.slug === slug)) {
          return yield* new ToolError({ reason: `${slug} is taken` });
        }
        const action: AgentAction = {
          op: a.action,
          slug,
          ...(a.new_slug !== undefined && { newSlug: a.new_slug.trim().toLowerCase() }),
          ...(a.name !== undefined && { name: a.name }),
          ...(a.role !== undefined && { role: a.role }),
          ...(a.persona !== undefined && { persona: a.persona }),
          ...(tools !== undefined && { tools }),
          ...(a.model !== undefined && { model: a.model }),
        };
        yield* (yield* Approvals).add(
          "",
          describeAgentAction(action),
          "",
          place ?? "",
          encodeAgentAction(action),
        );
        return "Waiting for the user's approval. They have been shown Approve and Deny buttons.";
      }),
  }),
];

export const profileTools = [
  defineTool({
    name: "profile_manage",
    path: "profile.manage",
    description:
      "Read or change what every agent knows about the user. Use it when you learn a stable fact about them, or a rule they want followed everywhere. Do not put conversation details here.",
    args: ProfileArgs,
    run: (a) =>
      Effect.gen(function* () {
        const host = yield* Host;
        if (a.action === "get") {
          const profile = describeProfile(yield* host.profile);
          return profile === "" ? "No profile yet." : profile;
        }
        if (a.about === undefined && a.rules === undefined) {
          return yield* new ToolError({ reason: "update needs about, rules, or both" });
        }
        const saved = yield* host.updateProfile(a.about, a.rules);
        return `Profile saved: ${saved.about === "" ? "no about" : "about"}, ${saved.rules.length} rule(s).`;
      }),
  }),
];
