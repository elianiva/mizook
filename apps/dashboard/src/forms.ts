import { Option, Schema } from "effect";

import { AgentKind, type AgentManagement } from "./api.ts";

const Fields = Schema.Record(Schema.String, Schema.String);

/** The skill, intent, policy or profile form that is open. `id` is empty for a new one. */
export const OpenAgentForm = Schema.Option(
  Schema.Struct({ kind: AgentKind, id: Schema.String, fields: Fields }),
);

/** The Agents page form. `slug` is the agent being changed, empty for a new one. */
export const AgentForm = Schema.Struct({ slug: Schema.String, fields: Fields });
export type AgentForm = typeof AgentForm.Type;

export const OpenAgentManagerForm = Schema.Option(AgentForm);

export const emptyAgentForm = (): AgentForm => ({
  slug: "",
  fields: { slug: "", name: "", role: "", persona: "", model: "", tools: "" },
});

/** One tool path or namespace per line or comma. No entries means every tool. */
export const toolsOf = (text: string): string[] =>
  text
    .split(/[\n,]+/)
    .map((tool) => tool.trim())
    .filter((tool) => tool !== "");

export const AGENT_SLUG = /^[a-z][a-z0-9_]{1,31}$/;

export const agentFormReady = (form: AgentForm): boolean => {
  const slug = (form.fields["slug"] ?? "").trim();
  const name = (form.fields["name"] ?? "").trim();
  return AGENT_SLUG.test(slug) && name !== "" && name.length <= 64;
};

export const managementOf = (form: AgentForm): AgentManagement => {
  const tools = toolsOf(form.fields["tools"] ?? "");
  return {
    slug: (form.fields["slug"] ?? "").trim(),
    name: (form.fields["name"] ?? "").trim(),
    role: form.fields["role"] ?? "",
    persona: form.fields["persona"] ?? "",
    model: (form.fields["model"] ?? "").trim(),
    tools: tools.length === 0 ? null : tools,
  };
};

export const maybeForm = (form: AgentForm): Option.Option<AgentForm> => Option.some(form);
