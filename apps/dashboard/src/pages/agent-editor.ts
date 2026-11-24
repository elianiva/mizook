import { Effect, Option, Array, Schema } from "effect";
import { AsyncData, Command, type Update } from "foldkit";
import type { Html } from "foldkit/html";
import { modifyFields } from "foldkit/struct";
import { Confirmation, isArmed } from "@mizook/ui/confirmation";
import {
  AgentEdit,
  AgentKind,
  Decision,
  type IntentRow,
  type PolicyRow,
  type Profile,
  type SkillRow,
} from "@mizook/admin-api";

import {
  channelKey,
  intentsQuery,
  policiesQuery,
  postAgent,
  profileQuery,
  skillsQuery,
} from "../api.ts";
import { currentChannel } from "../channel.ts";
import { OpenAgentForm } from "../forms.ts";
import { Message } from "../message.ts";
import type { Model } from "../model.ts";
import { patch, patchKeyed } from "../optimistic.ts";
import type { H } from "../view/common.ts";
import { ui } from "../ui.ts";

type UpdateReturn = Update.Return<Model, Message>;

type AgentEditor = {
  readonly kind: AgentKind;
  readonly id: string;
  readonly fields: { readonly [key: string]: string };
};

export const editorFor = (model: Model, kind: AgentKind): Option.Option<AgentEditor> =>
  Option.flatMap(model.editor, (editor) =>
    editor.kind === kind ? Option.some(editor) : Option.none(),
  );

export const agentField = (label: string, control: Html, h: H): Html =>
  h.div(
    [h.Class(ui.field)],
    [h.div([h.Class(ui.fieldLabel)], [h.span([h.Class(ui.strong)], [label])]), control, h.empty],
  );

const agentText = (
  key: string,
  label: string,
  value: string,
  h: H,
  placeholder?: string,
  disabled = false,
): Html =>
  agentField(
    label,
    h.input([
      h.Class(`${ui.input} ${ui.fullWidth}`),
      h.Type("text"),
      h.AriaLabel(label),
      ...(placeholder === undefined ? [] : [h.Placeholder(placeholder)]),
      ...(disabled ? [h.Disabled(true)] : []),
      h.Value(value),
      h.OnInput((next) => Message.UpdatedAgentField({ key, value: next })),
    ]),
    h,
  );

const agentTextarea = (
  key: string,
  label: string,
  value: string,
  h: H,
  placeholder?: string,
  tall = false,
): Html =>
  agentField(
    label,
    h.textarea([
      h.Class(ui.textarea),
      ...(tall ? [h.Style({ minHeight: "260px" })] : []),
      h.AriaLabel(label),
      ...(placeholder === undefined ? [] : [h.Placeholder(placeholder)]),
      h.Value(value),
      h.OnInput((next) => Message.UpdatedAgentField({ key, value: next })),
    ]),
    h,
  );

const agentNumber = (key: string, label: string, value: string, min: string, h: H): Html =>
  agentField(
    label,
    h.input([
      h.Class(`${ui.input} ${ui.fullWidth}`),
      h.Type("number"),
      h.Min(min),
      h.Step("1"),
      h.AriaLabel(label),
      h.Value(value),
      h.OnInput((next) => Message.UpdatedAgentField({ key, value: next })),
    ]),
    h,
  );

const agentDate = (key: string, label: string, value: string, h: H): Html =>
  agentField(
    label,
    h.input([
      h.Class(`${ui.input} ${ui.fullWidth}`),
      h.Type("date"),
      h.AriaLabel(label),
      h.Value(value),
      h.OnInput((next) => Message.UpdatedAgentField({ key, value: next })),
    ]),
    h,
  );

const agentPinned = (value: string, h: H): Html =>
  agentField("Pinned", h.span([h.Class(ui.badge)], [value === "1" ? "yes" : "no"]), h);

const agentDecision = (value: string, h: H): Html =>
  agentField(
    "Decision",
    h.select(
      [
        h.Class(ui.select),
        h.AriaLabel("Decision"),
        h.OnChange((next) => Message.UpdatedAgentField({ key: "decision", value: next })),
      ],
      Array.map(["allow", "ask", "deny"], (choice) =>
        h.option([h.Value(choice), h.Selected(value === choice)], [choice]),
      ),
    ),
    h,
  );

const agentReady = (editor: AgentEditor): boolean => {
  const fields = editor.fields;
  if (editor.kind === "profile") return true;
  if (editor.kind === "skills") {
    const name = editor.id || (fields.name ?? "");
    return (
      /^[a-z0-9][a-z0-9-]{0,63}$/.test(name) &&
      (fields.description ?? "").trim() !== "" &&
      (fields.body ?? "").trim() !== ""
    );
  }
  if (editor.kind === "intents") {
    const maxFires = Number(fields.maxFires);
    const cooldownHours = Number(fields.cooldownHours);
    return (
      (fields.description ?? "").trim() !== "" &&
      (fields.triggers ?? "").trim() !== "" &&
      (fields.expires ?? "") !== "" &&
      Number.isInteger(maxFires) &&
      maxFires >= 1 &&
      Number.isFinite(cooldownHours) &&
      cooldownHours >= 0
    );
  }
  return (fields.match ?? "").trim() !== "";
};

export const agentForm = (
  model: Model,
  editor: AgentEditor,
  h: H,
  destructive?: { readonly label: string },
): Html => {
  const fields = editor.fields;
  const ready = agentReady(editor);
  const armed = isArmed(model.armed, `agent-remove:${editor.kind}:${editor.id}`);
  const controls =
    editor.kind === "profile"
      ? [
          agentTextarea(
            "about",
            "About",
            fields.about ?? "",
            h,
            "Who the user is, in a few lines.",
          ),
          agentTextarea("rules", "Rules", fields.rules ?? "", h, "One rule per line."),
        ]
      : editor.kind === "skills"
        ? [
            agentText(
              "name",
              "Name",
              editor.id || (fields.name ?? ""),
              h,
              "weekly-review",
              editor.id !== "",
            ),
            agentText("description", "When to use it", fields.description ?? "", h, "One line."),
            agentTextarea(
              "body",
              "Steps",
              fields.body ?? "",
              h,
              "Inputs, steps, output, checks, and what needs approval.",
              true,
            ),
            agentPinned(fields.pinned ?? "0", h),
          ]
        : editor.kind === "intents"
          ? [
              agentTextarea(
                "description",
                "What to do",
                fields.description ?? "",
                h,
                "An instruction to yourself.",
              ),
              agentText("triggers", "Triggers", fields.triggers ?? "", h, "launch, rollback"),
              agentDate("expires", "Expires", fields.expires ?? "", h),
              agentNumber("maxFires", "Max fires", fields.maxFires ?? "3", "1", h),
              agentNumber("cooldownHours", "Cooldown hours", fields.cooldownHours ?? "24", "0", h),
            ]
          : [
              agentText("match", "Match", fields.match ?? "", h, "gmail.send"),
              agentDecision(fields.decision ?? "ask", h),
            ];

  return h.div(
    [h.Class(ui.stack)],
    [
      h.div([h.Class(ui.form)], controls),
      h.div(
        [h.Class(ui.actions)],
        [
          h.button(
            [
              h.Type("button"),
              h.Class(ready ? ui.buttonPrimary : ui.button),
              h.Disabled(!ready),
              h.OnClick(Message.ClickedAgentSave()),
            ],
            ["Save"],
          ),
          ...(destructive === undefined || editor.id === ""
            ? []
            : [
                h.button(
                  [
                    h.Type("button"),
                    h.Class(ui.buttonDanger),
                    h.OnClick(
                      Message.ClickedAgentRemove({
                        kind: editor.kind,
                        id: editor.id,
                      }),
                    ),
                  ],
                  [armed ? `Confirm ${destructive.label.toLowerCase()}` : destructive.label],
                ),
              ]),
          h.button(
            [h.Type("button"), h.Class(ui.button), h.OnClick(Message.ClickedAgentClose())],
            ["Close"],
          ),
        ],
      ),
    ],
  );
};

export const agentNew = (kind: AgentKind, label: string, h: H): Html =>
  h.button(
    [h.Type("button"), h.Class(ui.buttonSmall), h.OnClick(Message.ClickedAgentNew({ kind }))],
    [label],
  );

export const agentEdit = (kind: AgentKind, id: string, h: H): Html =>
  h.button(
    [h.Type("button"), h.Class(ui.buttonSmall), h.OnClick(Message.ClickedAgentEdit({ kind, id }))],
    ["Edit"],
  );

const PostAgent = Command.define("PostAgent", {
  args: { channel: Schema.String, edit: AgentEdit, editor: OpenAgentForm },
  messages: [Message.SucceededAction, Message.FailedAgentEdit],
  execute: ({ channel, edit, editor }) =>
    postAgent(channel, edit).pipe(
      Effect.as(Message.SucceededAction()),
      Effect.catch((reason) => Effect.succeed(Message.FailedAgentEdit({ reason, editor }))),
    ),
});

const dateField = (at: number): string => new Date(at).toISOString().slice(0, 10);

const isDecision = Schema.is(Decision);

const defaultFields = (kind: AgentKind): { readonly [key: string]: string } =>
  kind === "profile"
    ? { about: "", rules: "" }
    : kind === "skills"
      ? { name: "", description: "", body: "", pinned: "0" }
      : kind === "intents"
        ? {
            description: "",
            triggers: "",
            expires: dateField(Date.now() + 90 * 86_400_000),
            maxFires: "3",
            cooldownHours: "24",
          }
        : { match: "", decision: "ask" };

const fieldsFor = (
  model: Model,
  kind: AgentKind,
  id: string,
): { readonly [key: string]: string } | undefined => {
  if (kind === "profile") {
    return Option.match(AsyncData.getData(profileQuery.read(model.profile)), {
      onNone: () => undefined,
      onSome: (profile) => ({ about: profile.about, rules: profile.rules.join("\n") }),
    });
  }
  const channel = currentChannel(model);
  if (Option.isNone(channel)) return undefined;
  if (kind === "skills") {
    const rows = Option.getOrElse(
      AsyncData.getData(skillsQuery.read(model.skills, { channel: channel.value })),
      () => [],
    );
    const row = rows.find((item) => item.name === id);
    return row
      ? {
          name: row.name,
          description: row.description,
          body: row.body,
          pinned: row.pinned ? "1" : "0",
        }
      : defaultFields(kind);
  }
  if (kind === "intents") {
    const rows = Option.getOrElse(
      AsyncData.getData(intentsQuery.read(model.intents, { channel: channel.value })),
      () => [],
    );
    const row = rows.find((item) => String(item.id) === id);
    return row
      ? {
          description: row.description,
          triggers: row.triggers.join(", "),
          expires: dateField(row.expires),
          maxFires: String(row.maxFires),
          cooldownHours: String(row.cooldown / 3_600_000),
        }
      : defaultFields(kind);
  }
  const rows = Option.getOrElse(
    AsyncData.getData(policiesQuery.read(model.policies, { channel: channel.value })),
    () => [],
  );
  const row = rows.find((item) => String(item.id) === id);
  return row ? { match: row.match, decision: row.decision } : defaultFields(kind);
};

export const openEditor = (model: Model, kind: AgentKind, id: string): UpdateReturn => {
  const fields = fieldsFor(model, kind, id);
  if (!fields) return { model };
  return {
    model: modifyFields(model, {
      editor: () => Option.some<AgentEditor>({ kind, id, fields }),
      armed: () => Confirmation.Resting(),
      notice: () => Option.none(),
    }),
  };
};

const triggersOf = (text: string): string[] =>
  text
    .split(/[\n,]+/)
    .map((trigger) => trigger.trim())
    .filter((trigger) => trigger !== "");

const editOf = (editor: AgentEditor): AgentEdit | undefined => {
  const fields = editor.fields;
  switch (editor.kind) {
    case "profile":
      return {
        kind: "profile",
        action: "save",
        about: fields.about ?? "",
        rules: (fields.rules ?? "")
          .split("\n")
          .map((rule) => rule.trim())
          .filter((rule) => rule !== ""),
      };
    case "skills":
      return {
        kind: "skills",
        action: "save",
        name: (editor.id || fields.name || "").trim(),
        description: fields.description ?? "",
        body: fields.body ?? "",
      };
    case "intents": {
      const expires = Date.parse(`${fields.expires ?? ""}T23:59:59.999Z`);
      return {
        kind: "intents",
        action: "save",
        ...(editor.id === "" ? {} : { id: Number(editor.id) }),
        description: fields.description ?? "",
        triggers: triggersOf(fields.triggers ?? ""),
        expires: Number.isFinite(expires) ? expires : 0,
        maxFires: Number(fields.maxFires ?? ""),
        cooldownHours: Number(fields.cooldownHours ?? ""),
      };
    }
    case "policies":
      return {
        kind: "policies",
        action: "save",
        ...(editor.id === "" ? {} : { id: Number(editor.id) }),
        match: fields.match ?? "",
        decision: isDecision(fields.decision) ? fields.decision : "ask",
      };
  }
};

const removalOf = (kind: AgentKind, id: string): AgentEdit | undefined =>
  kind === "skills"
    ? { kind: "skills", action: "delete", name: id }
    : kind === "intents"
      ? { kind: "intents", action: "cancel", id: Number(id) }
      : kind === "policies"
        ? { kind: "policies", action: "remove", id: Number(id) }
        : undefined;

const withEdit = (model: Model, channel: string, edit: AgentEdit): Model => {
  const key = channelKey({ channel });
  switch (edit.kind) {
    case "profile":
      return modifyFields(model, {
        profile: (query) =>
          patch<Profile>()(query, () => ({
            about: edit.about ?? "",
            rules: edit.rules ?? [],
          })),
      });
    case "skills": {
      const name = edit.name ?? "";
      return modifyFields(model, {
        skills: (query) =>
          patchKeyed<ReadonlyArray<SkillRow>>()(query, key, (rows) =>
            edit.action === "delete"
              ? rows.filter((row) => row.name !== name)
              : rows.some((row) => row.name === name)
                ? rows.map((row) =>
                    row.name === name
                      ? { ...row, description: edit.description ?? "", body: edit.body ?? "" }
                      : row,
                  )
                : [
                    ...rows,
                    {
                      name,
                      description: edit.description ?? "",
                      body: edit.body ?? "",
                      pinned: false,
                      useCount: 0,
                      usedAt: null,
                      updated: Date.now(),
                    },
                  ],
          ),
      });
    }
    case "intents":
      return modifyFields(model, {
        intents: (query) =>
          patchKeyed<ReadonlyArray<IntentRow>>()(query, key, (rows) =>
            edit.action === "cancel"
              ? rows.map((row) => (row.id === edit.id ? { ...row, state: "cancelled" } : row))
              : rows.map((row) =>
                  row.id === edit.id
                    ? {
                        ...row,
                        description: edit.description ?? row.description,
                        triggers: edit.triggers ?? row.triggers,
                        expires: edit.expires ?? row.expires,
                        maxFires: edit.maxFires ?? row.maxFires,
                        cooldown:
                          edit.cooldownHours === undefined
                            ? row.cooldown
                            : edit.cooldownHours * 3_600_000,
                      }
                    : row,
                ),
          ),
      });
    case "policies":
      return modifyFields(model, {
        policies: (query) =>
          patchKeyed<ReadonlyArray<PolicyRow>>()(query, key, (rows) =>
            edit.action === "remove"
              ? rows.filter((row) => row.id !== edit.id)
              : rows.map((row) =>
                  row.id === edit.id
                    ? {
                        ...row,
                        match: edit.match ?? row.match,
                        decision: edit.decision ?? row.decision,
                      }
                    : row,
                ),
          ),
      });
  }
};

export const editField = (model: Model, key: string, value: string): UpdateReturn => ({
  model: modifyFields(model, {
    editor: (editor) =>
      Option.map(editor, (open) => ({
        ...open,
        fields: { ...open.fields, [key]: value },
      })),
  }),
});

export const closeEditor = (model: Model): UpdateReturn => ({
  model: modifyFields(model, {
    editor: () => Option.none(),
    armed: () => Confirmation.Resting(),
  }),
});

export const saveEditor = (model: Model): UpdateReturn =>
  Option.match(model.editor, {
    onNone: () => ({ model }),
    onSome: (editor) => {
      const edit = editOf(editor);
      if (!edit) return { model };
      return Option.match(currentChannel(model), {
        onNone: () => ({ model }),
        onSome: (channel) => ({
          model: modifyFields(withEdit(model, channel, edit), {
            editor: () => Option.none(),
            notice: () => Option.none(),
          }),
          commands: [PostAgent({ channel, edit, editor: model.editor })],
        }),
      });
    },
  });

export const removeEditorEntry = (model: Model, kind: AgentKind, id: string): UpdateReturn => {
  const key = `agent-remove:${kind}:${id}`;
  if (!isArmed(model.armed, key)) {
    return {
      model: modifyFields(model, {
        armed: () => Confirmation.Armed({ key }),
        notice: () => Option.none(),
      }),
    };
  }
  const edit = removalOf(kind, id);
  if (!edit) return { model };
  return Option.match(currentChannel(model), {
    onNone: () => ({ model }),
    onSome: (channel) => ({
      model: modifyFields(withEdit(model, channel, edit), {
        armed: () => Confirmation.Resting(),
        editor: () => Option.none(),
      }),
      commands: [PostAgent({ channel, edit, editor: model.editor })],
    }),
  });
};
