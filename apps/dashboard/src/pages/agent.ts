import { Option, Array } from "effect";
import { AsyncData } from "foldkit";
import type { Html } from "foldkit/html";
import { SkillRow, IntentRow, PolicyRow } from "@mizook/admin-api";

import { skillsQuery, intentsQuery, policiesQuery } from "../api.ts";
import { count, ago } from "../format.ts";
import type { Model } from "../model.ts";
import {
  type H,
  remote,
  skeletonView,
  emptyView,
  tableView,
  th,
  when,
  sectionView,
} from "../view/common.ts";
import { editorFor, agentForm, agentNew, agentEdit } from "./agent-editor.ts";
import { ui } from "../ui.ts";

const skillsBody = (model: Model, channel: string, h: H): Html => {
  const editor = editorFor(model, "skills");
  if (Option.isSome(editor)) {
    return agentForm(
      model,
      editor.value,
      h,
      editor.value.fields.pinned === "1" ? undefined : { label: "Delete skill" },
    );
  }
  return remote(skillsQuery.read(model.skills, { channel }), h, skeletonView(h, 1), (rows) =>
    h.div(
      [h.Class(ui.section)],
      [
        h.div([h.Class(ui.toolbar)], [agentNew("skills", "New skill", h)]),
        Array.match(rows, {
          onEmpty: () =>
            emptyView("No skills yet. The agent saves one after a repeatable task.", h),
          onNonEmpty: (list) =>
            tableView(
              [
                th("Skill", h),
                th("When to use it", h),
                th("Pinned", h),
                th("Uses", h, true),
                th("Last used", h),
                th("Actions", h),
              ],
              Array.map(list, (skill: SkillRow) =>
                h.keyed("tr")(
                  skill.name,
                  [h.Class(ui.row)],
                  [
                    h.td([h.Class(ui.tdMono)], [skill.name]),
                    h.td([h.Class(ui.td)], [h.div([h.Class(ui.clamp)], [skill.description])]),
                    h.td([h.Class(ui.tdFit)], [skill.pinned ? "yes" : "–"]),
                    h.td([h.Class(ui.tdNum)], [count(skill.useCount)]),
                    h.td(
                      [h.Class(ui.tdFit)],
                      [skill.usedAt === null ? "never" : ago(skill.usedAt)],
                    ),
                    h.td([h.Class(ui.td)], [agentEdit("skills", skill.name, h)]),
                  ],
                ),
              ),
              h,
            ),
        }),
      ],
    ),
  );
};

const intentStateColor = (state: string): string =>
  state === "armed"
    ? "var(--colors-ok)"
    : state === "expired"
      ? "var(--colors-warn)"
      : "var(--colors-fg-muted)";

const intentsBody = (model: Model, channel: string, h: H): Html => {
  const editor = editorFor(model, "intents");
  if (Option.isSome(editor)) {
    const current = Option.getOrElse(
      AsyncData.getData(intentsQuery.read(model.intents, { channel })),
      () => [],
    ).find((intent) => String(intent.id) === editor.value.id);
    return agentForm(
      model,
      editor.value,
      h,
      current?.state === "armed" ? { label: "Cancel intent" } : undefined,
    );
  }
  return remote(intentsQuery.read(model.intents, { channel }), h, skeletonView(h, 1), (rows) =>
    h.div(
      [h.Class(ui.section)],
      [
        h.div([h.Class(ui.toolbar)], [agentNew("intents", "New intent", h)]),
        Array.match(rows, {
          onEmpty: () => emptyView("No standing intents.", h),
          onNonEmpty: (list) =>
            tableView(
              [
                th("#", h),
                th("State", h),
                th("Triggers", h),
                th("What to do", h),
                th("Fires", h, true),
                th("Expires", h),
                th("Actions", h),
              ],
              Array.map(list, (intent: IntentRow) =>
                h.keyed("tr")(
                  String(intent.id),
                  [h.Class(ui.row)],
                  [
                    h.td([h.Class(ui.tdMono)], [`#${intent.id}`]),
                    h.td(
                      [h.Class(ui.td)],
                      [
                        h.span(
                          [h.Class(ui.badge), h.Style({ color: intentStateColor(intent.state) })],
                          [intent.state],
                        ),
                      ],
                    ),
                    h.td([h.Class(ui.tdMono)], [intent.triggers.join(", ")]),
                    h.td([h.Class(ui.td)], [h.div([h.Class(ui.clamp)], [intent.description])]),
                    h.td([h.Class(ui.tdNum)], [`${intent.fireCount}/${intent.maxFires}`]),
                    h.td([h.Class(ui.tdFitMono)], [when(intent.expires, h)]),
                    h.td([h.Class(ui.td)], [agentEdit("intents", String(intent.id), h)]),
                  ],
                ),
              ),
              h,
            ),
        }),
      ],
    ),
  );
};

const decisionColor = (decision: string): string =>
  decision === "allow"
    ? "var(--colors-ok)"
    : decision === "deny"
      ? "var(--colors-danger)"
      : "var(--colors-warn)";

const policiesBody = (model: Model, channel: string, h: H): Html => {
  const editor = editorFor(model, "policies");
  if (Option.isSome(editor)) {
    return agentForm(model, editor.value, h, { label: "Remove policy" });
  }
  return remote(policiesQuery.read(model.policies, { channel }), h, skeletonView(h, 1), (rows) =>
    h.div(
      [h.Class(ui.section)],
      [
        h.div([h.Class(ui.toolbar)], [agentNew("policies", "New policy", h)]),
        Array.match(rows, {
          onEmpty: () =>
            emptyView("No policies. Every executor action asks or runs as it did before.", h),
          onNonEmpty: (list) =>
            tableView(
              [th("#", h), th("Decision", h), th("Match", h), th("Actions", h)],
              Array.map(list, (policy: PolicyRow) =>
                h.keyed("tr")(
                  String(policy.id),
                  [h.Class(ui.row)],
                  [
                    h.td([h.Class(ui.tdMono)], [`#${policy.id}`]),
                    h.td(
                      [h.Class(ui.td)],
                      [
                        h.span(
                          [h.Class(ui.badge), h.Style({ color: decisionColor(policy.decision) })],
                          [policy.decision],
                        ),
                      ],
                    ),
                    h.td([h.Class(ui.tdMono)], [policy.match]),
                    h.td([h.Class(ui.td)], [agentEdit("policies", String(policy.id), h)]),
                  ],
                ),
              ),
              h,
            ),
        }),
      ],
    ),
  );
};

export const agentView = (model: Model, channel: string, h: H): Html =>
  h.div(
    [h.Class(ui.stack)],
    [
      sectionView("Skills", skillsBody(model, channel, h), h),
      sectionView("Standing intents", intentsBody(model, channel, h), h),
      sectionView("Policies", policiesBody(model, channel, h), h),
    ],
  );
