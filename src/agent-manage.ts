import { Effect, Schema } from "effect";
import type { Host } from "./host.ts";

export const AgentAction = Schema.Struct({
  op: Schema.Literals(["create", "update", "delete"]),
  slug: Schema.String,
  newSlug: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(Schema.String),
  persona: Schema.optionalKey(Schema.String),
  tools: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  model: Schema.optionalKey(Schema.String),
});
export type AgentAction = typeof AgentAction.Type;

const AgentActionJson = Schema.fromJsonString(AgentAction);
export const encodeAgentAction = Schema.encodeSync(AgentActionJson);
const decodeAgentAction = Schema.decodeUnknownEffect(AgentActionJson);

export const describeAgentAction = (a: AgentAction): string => {
  const parts = [
    a.newSlug === undefined ? "" : `slug /${a.newSlug}`,
    a.name === undefined ? "" : `name "${a.name}"`,
    a.role === undefined ? "" : `role: ${a.role.slice(0, 300)}`,
    a.persona === undefined ? "" : "own persona",
    a.tools === undefined ? "" : a.tools === null ? "every tool" : `tools: ${a.tools.join(", ")}`,
    a.model === undefined ? "" : `model ${a.model}`,
  ].filter((part) => part !== "");
  const what = parts.length === 0 ? "" : ` (${parts.join("; ")})`;
  return a.op === "create"
    ? `Create agent /${a.slug}${what}`
    : a.op === "update"
      ? `Change agent /${a.slug}${what}`
      : `Delete agent /${a.slug} and everything it remembers`;
};

export const applyAgentAction = (host: Host["Service"], json: string) =>
  Effect.gen(function* () {
    const a = yield* decodeAgentAction(json);
    const change =
      a.op === "create"
        ? yield* host.createAgent({
            slug: a.slug,
            name: a.name ?? a.slug,
            role: a.role ?? "",
            persona: a.persona ?? "",
            ...(a.tools !== undefined && { tools: a.tools }),
          })
        : a.op === "update"
          ? yield* host.updateAgent(a.slug, {
              ...(a.newSlug !== undefined && { slug: a.newSlug }),
              ...(a.name !== undefined && { name: a.name }),
              ...(a.role !== undefined && { role: a.role }),
              ...(a.persona !== undefined && { persona: a.persona }),
              ...(a.tools !== undefined && { tools: a.tools }),
            })
          : yield* host.deleteAgent(a.slug);
    if (!change.ok) return `It failed: ${change.error}.`;
    const agent = change.agent;
    if (a.op === "delete") return `Deleted /${agent.slug}.`;
    if (a.model !== undefined) yield* host.setAgentSetting(agent.doName, "model", a.model);
    const runningAgentMustRereadConfig = a.op === "update";
    if (runningAgentMustRereadConfig) yield* host.reloadAgent(agent.doName);
    return `${a.op === "create" ? "Created" : "Changed"} /${agent.slug} (${agent.name}).`;
  }).pipe(Effect.catch((error) => Effect.succeed(`It failed: ${String(error)}.`)));
