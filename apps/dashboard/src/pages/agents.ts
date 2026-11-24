import { css } from "../../styled-system/css";
import { Option, Array } from "effect";
import type { Html } from "foldkit/html";
import { icon } from "@mizook/ui/icon";
import { isArmed } from "@mizook/ui/confirmation";
import type { AgentRow } from "@mizook/admin-api";

import { agentsQuery } from "../api.ts";
import { Message } from "../message.ts";
import type { Model } from "../model.ts";
import { type AgentForm, agentFormReady, AGENT_SLUG } from "../forms.ts";
import { type H, remote, skeletonView } from "../view/common.ts";
import { agentField } from "./agent-editor.ts";
import { mono, ui as shared } from "../ui.ts";

const ui = {
  ...shared,
  agentGrid: css({
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))",
    gap: "14px",
    alignItems: "stretch",
  }),
  agentCard: css({
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    border: "1px solid {colors.border}",
    backgroundColor: "bg",
  }),
  agentHead: css({
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "16px 16px 10px",
  }),
  agentMark: css({
    width: "32px",
    height: "32px",
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid {colors.border}",
    backgroundColor: "accentSubtle",
    color: "accent",
  }),
  agentIdentity: css({
    flex: "1",
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: "1px",
  }),
  agentName: css({
    color: "heading",
    fontSize: "lg",
    fontWeight: "700",
    letterSpacing: "tight",
    lineHeight: "1.25",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  }),
  agentSlug: css({ ...mono, color: "fgMuted", overflow: "hidden", textOverflow: "ellipsis" }),
  agentRole: css({
    lineClamp: "3",
    wordBreak: "break-word",
    paddingInline: "16px",
    marginBottom: "16px",
    color: "fgMuted",
    fontSize: "sm",
    lineHeight: "1.5",
  }),
  agentRoleQuiet: css({ color: "fgFaint" }),
  agentFoot: css({
    marginTop: "auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    padding: "10px 16px",
    borderTop: "1px dashed {colors.border}",
  }),
  agentMeta: css({
    ...mono,
    minWidth: 0,
    color: "fgMuted",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  }),
};

const managerText = (key: string, label: string, value: string, h: H, placeholder: string): Html =>
  agentField(
    label,
    h.input([
      h.Class(`${ui.input} ${ui.fullWidth}`),
      h.Type("text"),
      h.AriaLabel(label),
      h.Placeholder(placeholder),
      h.Value(value),
      h.OnInput((next) => Message.UpdatedAgentManageField({ key, value: next })),
    ]),
    h,
  );

const managerTextarea = (
  key: string,
  label: string,
  value: string,
  h: H,
  placeholder: string,
  tall = false,
): Html =>
  agentField(
    label,
    h.textarea([
      h.Class(ui.textarea),
      ...(tall ? [h.Style({ minHeight: "200px" })] : []),
      h.AriaLabel(label),
      h.Placeholder(placeholder),
      h.Value(value),
      h.OnInput((next) => Message.UpdatedAgentManageField({ key, value: next })),
    ]),
    h,
  );

const agentManagerForm = (
  model: Model,
  form: AgentForm,
  row: Option.Option<AgentRow>,
  h: H,
): Html => {
  const fields = form.fields;
  const isNew = form.slug === "";
  const ready = agentFormReady(form);
  const isDefault = Option.exists(row, (agent) => agent.isDefault);
  const armed = isArmed(model.armed, `agent-delete:${form.slug}`);
  const slug = (fields["slug"] ?? "").trim();
  return h.div(
    [h.Class(ui.stack)],
    [
      h.div(
        [h.Class(ui.form)],
        [
          managerText("name", "Name", fields["name"] ?? "", h, "Fact-checker"),
          managerText("slug", "Command", fields["slug"] ?? "", h, "factchecker"),
          slug !== "" && !AGENT_SLUG.test(slug)
            ? h.p(
                [h.Class(ui.danger)],
                ["Lowercase letters, digits and _, 2 to 32, starting with a letter."],
              )
            : h.empty,
          managerTextarea(
            "role",
            "Role",
            fields["role"] ?? "",
            h,
            "What this agent is for. Added to its instructions.",
            true,
          ),
          managerText("model", "Model", fields["model"] ?? "", h, "default"),
          managerTextarea(
            "persona",
            "Persona",
            fields["persona"] ?? "",
            h,
            "Empty uses the shared persona.",
          ),
          managerTextarea(
            "tools",
            "Only these tools",
            fields["tools"] ?? "",
            h,
            "One path or namespace per line, like gmail or executor.search. Empty gives every tool.",
          ),
        ],
      ),
      h.div(
        [h.Class(ui.actions)],
        [
          h.button(
            [
              h.Type("button"),
              h.Class(ready ? ui.buttonPrimary : ui.button),
              h.Disabled(!ready),
              h.OnClick(Message.ClickedAgentManageSave()),
            ],
            [isNew ? "Create agent" : "Save"],
          ),
          ...(isNew || isDefault
            ? []
            : [
                h.button(
                  [
                    h.Type("button"),
                    h.Class(ui.buttonDanger),
                    h.OnClick(Message.ClickedAgentManageDelete({ slug: form.slug })),
                  ],
                  [armed ? "Confirm: delete it and its memory" : "Delete agent"],
                ),
              ]),
          h.button(
            [h.Type("button"), h.Class(ui.button), h.OnClick(Message.ClickedAgentManageClose())],
            ["Close"],
          ),
        ],
      ),
    ],
  );
};

const agentCard = (row: AgentRow, h: H): Html => {
  const noRole = row.role.trim() === "";
  return h.keyed("div")(
    row.slug,
    [h.Class(ui.agentCard)],
    [
      h.div(
        [h.Class(ui.agentHead)],
        [
          h.span([h.Class(ui.agentMark)], [icon(h, "bot", 17)]),
          h.div(
            [h.Class(ui.agentIdentity)],
            [
              h.span([h.Class(ui.agentName)], [row.name]),
              h.span([h.Class(ui.agentSlug)], [`/${row.slug}`]),
            ],
          ),
          row.isDefault ? h.span([h.Class(ui.badge)], ["default"]) : h.empty,
        ],
      ),
      h.p(
        [h.Class(noRole ? `${ui.agentRole} ${ui.agentRoleQuiet}` : ui.agentRole)],
        [noRole ? "No role. It answers as the default persona." : row.role],
      ),
      h.div(
        [h.Class(ui.agentFoot)],
        [
          h.span(
            [h.Class(ui.agentMeta)],
            [
              `${row.model === "" ? "default model" : row.model} · ${
                row.tools === null ? "every tool" : `${row.tools.length} tools`
              }`,
            ],
          ),
          h.button(
            [
              h.Type("button"),
              h.Class(ui.buttonSmall),
              h.OnClick(Message.ClickedAgentManage({ slug: row.slug })),
            ],
            [icon(h, "pencil", 13), "Edit"],
          ),
        ],
      ),
    ],
  );
};

export const agentsView = (model: Model, h: H): Html =>
  remote(agentsQuery.read(model.agents), h, skeletonView(h, 2), (rows) =>
    Option.match(model.agentForm, {
      onSome: (form) =>
        agentManagerForm(
          model,
          form,
          Array.findFirst(rows, (agent) => agent.slug === form.slug),
          h,
        ),
      onNone: () =>
        h.div(
          [h.Class(ui.agentGrid)],
          Array.map(rows, (row) => agentCard(row, h)),
        ),
    }),
  );
