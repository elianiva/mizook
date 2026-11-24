import { Effect, Schema } from "effect";
import { ToolError } from "./errors.ts";
import { Host } from "./host.ts";
import { Skills } from "./skills.ts";
import { defineTool, described } from "./tool.ts";

export const SkillArgs = Schema.Struct({
  action: described(
    Schema.Literals(["list", "read", "save", "delete"]),
    "list: names and descriptions. read: the full procedure. save: create or replace. delete: remove it.",
  ),
  scope: Schema.optionalKey(
    described(
      Schema.Literals(["agent", "global"]),
      "agent (default for save): only you see it. global: every agent sees it; use it for a procedure about the user rather than your role. read and delete look in yours first, then global, unless given.",
    ),
  ),
  name: Schema.optionalKey(
    described(
      Schema.String,
      "Lowercase letters, digits and dashes, up to 64. Required for read, save and delete.",
    ),
  ),
  description: Schema.optionalKey(
    described(Schema.String, "save: one line saying when to use it, up to 200 characters."),
  ),
  body: Schema.optionalKey(
    described(
      Schema.String,
      "save: the procedure. Steps, inputs, output, what to check, and what needs approval. Up to 24,000 characters.",
    ),
  ),
});

export const skillTools = [
  defineTool({
    name: "skill_manage",
    path: "skills.manage",
    description:
      "Keep procedures you can reuse: list, read, save or delete a skill. Save one after you work out a repeatable task. Read it before a task that matches its description. An automation can name a skill to read when it fires.",
    args: SkillArgs,
    run: (a) =>
      Effect.gen(function* () {
        const skills = yield* Skills;
        const global = (yield* Host).globalSkills;
        const findOwnFirstThenSharedUnlessScoped = (name: string) =>
          Effect.gen(function* () {
            if (a.scope !== "global") {
              const mine = yield* skills.get(name);
              if (mine) return { skill: mine, store: skills, scope: "agent" };
            }
            if (a.scope !== "agent") {
              const shared = yield* global.get(name);
              if (shared) return { skill: shared, store: global, scope: "global" };
            }
            return undefined;
          });
        switch (a.action) {
          case "list": {
            const mine = a.scope === "global" ? [] : yield* skills.list;
            const shared = a.scope === "agent" ? [] : yield* global.list;
            const lines = [
              ...mine.map((skill) => ({ skill, scope: "yours" })),
              ...shared.map((skill) => ({ skill, scope: "global" })),
            ].map(
              ({ skill, scope }) =>
                `- ${skill.name} (${scope}): ${skill.description}${skill.pinned ? " (pinned)" : ""}`,
            );
            return lines.length === 0 ? "No skills yet." : lines.join("\n");
          }
          case "read": {
            if (!a.name) return yield* new ToolError({ reason: "read needs a name" });
            const found = yield* findOwnFirstThenSharedUnlessScoped(a.name);
            if (!found) return yield* new ToolError({ reason: `no skill "${a.name}"` });
            yield* found.store.touch(a.name);
            return `# ${found.skill.name}\n${found.skill.description}\n\n${found.skill.body}`;
          }
          case "save": {
            const store = a.scope === "global" ? global : skills;
            const saved = yield* store.save(a.name ?? "", a.description ?? "", a.body ?? "");
            return `Saved ${a.scope === "global" ? "global " : ""}skill "${saved.name}".`;
          }
          case "delete": {
            if (!a.name) return yield* new ToolError({ reason: "delete needs a name" });
            const found = yield* findOwnFirstThenSharedUnlessScoped(a.name);
            if (!found) return `No skill "${a.name}".`;
            return (yield* found.store.remove(a.name))
              ? `Deleted ${found.scope === "global" ? "global " : ""}skill "${a.name}".`
              : `No skill "${a.name}".`;
          }
        }
      }),
  }),
];
