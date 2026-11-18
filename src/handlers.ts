import { clipToolOutput, Memory } from "@mizook/memory";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { Settings } from "./config.ts";
import { ScheduleError } from "./errors.ts";
import { formatDate } from "./format.ts";
import {
  Intents,
  MAX_INTENT_DESCRIPTION,
  MAX_INTENT_TRIGGERS,
  MAX_TRIGGER_LENGTH,
} from "./intents.ts";
import { Policies } from "./policies.ts";
import { Schedules, type Schedule } from "./schedules.ts";
import type { Spec } from "./schedule.ts";
import { MAX_SKILL_BODY, MAX_SKILL_DESCRIPTION, SKILL_NAME, Skills } from "./skills.ts";
import { KIND_TYPES } from "./artifact-render.ts";
import { Artifacts } from "./artifacts.ts";
import { Blobs } from "./blobs.ts";
import { Approvals } from "./approvals.ts";
import { Executor, pausedExecution } from "./executor.ts";
import { Host } from "./host.ts";
import { ToolError } from "./errors.ts";
import { channelKey, State } from "./state.ts";
import { Outbox } from "./outbox.ts";
import { Web } from "./search.ts";
import {
  AskChannelArgs,
  FileReadArgs,
  SendToUserArgs,
  ExecutorArgs,
  ArtifactDataArgs,
  ArtifactDeleteArgs,
  ArtifactHistoryArgs,
  ArtifactRestoreArgs,
  ArtifactPublishArgs,
  DateArgs,
  IntentArgs,
  PolicyArgs,
  ProfileArgs,
  ScheduleCancelArgs,
  ScheduleCreateArgs,
  SearchArgs,
  SkillArgs,
  WebFetchArgs,
  WebSearchArgs,
  ZoomArgs,
} from "./tools.ts";

/** What a tool does, by name. The arguments were already checked against the tool's schema. */
export class Handlers extends Context.Service<
  Handlers,
  { call(name: string, args: unknown): Effect.Effect<string> }
>()("mizook/Handlers") {
  static readonly layer = Layer.effect(
    Handlers,
    Effect.gen(function* () {
      const memory = yield* Memory;
      const schedules = yield* Schedules;
      const intents = yield* Intents;
      const policies = yield* Policies;
      const skills = yield* Skills;
      const web = yield* Web;
      const outbox = yield* Outbox;
      const executor = yield* Executor;
      const host = yield* Host;
      const approvals = yield* Approvals;
      const blobs = yield* Blobs;
      const artifacts = yield* Artifacts;
      const state = yield* State;
      const channel = channelKey(state);
      const { timezone } = yield* Settings;

      const describe = (s: Schedule) => {
        const { spec } = s;
        const what =
          spec.kind === "once"
            ? `once at ${spec.at}`
            : spec.kind === "cron"
              ? `cron "${spec.expr}" (${spec.timezone})`
              : `watch ${spec.url} every ${spec.everyMinutes} min`;
        return `#${s.id} ${what}${s.skill ? ` [skill ${s.skill}]` : ""}; next ${formatDate(new Date(s.nextAt), timezone)}; ${s.prompt}`;
      };

      const specOf = (a: typeof ScheduleCreateArgs.Type): Effect.Effect<Spec, ScheduleError> => {
        const missing = (what: string) => Effect.fail(new ScheduleError({ reason: what }));
        switch (a.kind) {
          case "once":
            return a.at ? Effect.succeed({ kind: "once", at: a.at }) : missing("once needs `at`");
          case "cron":
            return a.cron
              ? Effect.succeed({ kind: "cron", expr: a.cron, timezone })
              : missing("cron needs `cron`");
          case "watch":
            return a.url && a.every_minutes
              ? Effect.succeed({ kind: "watch", url: a.url, everyMinutes: a.every_minutes })
              : missing("watch needs `url` and `every_minutes`");
        }
      };

      const decode = <S extends Schema.Decoder<unknown>>(schema: S, args: unknown) =>
        Schema.decodeUnknownEffect(schema)(args);

      /** What a policy matches: the executor tool plus the paths of the calls inside it. */
      const targetOf = (tool: string, input: Record<string, unknown>): string => {
        const calls = Array.isArray(input.calls) ? input.calls : [];
        const paths = calls.flatMap((call) => {
          if (typeof call !== "object" || call === null || !("path" in call)) return [];
          const path = (call as { path?: unknown }).path;
          return typeof path === "string" ? [path] : [];
        });
        return [tool, ...paths].join(" ").toLowerCase();
      };

      const run = (
        name: string,
        args: unknown,
      ): Effect.Effect<string, { readonly message: string }> => {
        switch (name) {
          case "zoom":
            return Effect.flatMap(decode(ZoomArgs, args), (a) => memory.zoom(a.id, a.n));
          case "date":
            return Effect.flatMap(decode(DateArgs, args), (a) => memory.date(a.id));
          case "search":
            return Effect.gen(function* () {
              const a = yield* decode(SearchArgs, args);
              const query = a.query.trim();
              if (query === "") return yield* new ToolError({ reason: "search needs a query" });
              const hits = yield* memory.search(query, a.limit ?? 20);
              return hits.length === 0
                ? "No messages match."
                : hits
                    .map(
                      (hit) =>
                        `${hit.i} ${hit.kind} ${hit.date.slice(0, 10)}: ${hit.snippet.replace(/\s+/g, " ")}`,
                    )
                    .join("\n");
            });
          case "file_read":
            return Effect.gen(function* () {
              const a = yield* decode(FileReadArgs, args);
              if (!a.key.startsWith("inbox/")) {
                return yield* new ToolError({ reason: "only attached files can be read" });
              }
              const blob = yield* blobs.get(a.key);
              if (!blob) return yield* new ToolError({ reason: `no file ${a.key}` });
              const textual = /^(text\/|application\/(json|xml|x-yaml|javascript))/.test(
                blob.contentType,
              );
              return textual
                ? clipToolOutput(new TextDecoder().decode(blob.body))
                : `Binary file: ${blob.contentType}, ${blob.body.length} bytes. I cannot read its content.`;
            });
          case "webhook_link":
            return host.hookUrl;
          case "ask_channel":
            return Effect.flatMap(decode(AskChannelArgs, args), (a) =>
              host.ask(a.channel, a.question),
            );
          case "profile_manage":
            return Effect.gen(function* () {
              const a = yield* decode(ProfileArgs, args);
              if (a.action === "get") {
                const profile = yield* host.profile;
                if (profile.about.trim() === "" && profile.rules.length === 0) {
                  return "No profile yet.";
                }
                return [
                  profile.about.trim() === "" ? "" : `About: ${profile.about.trim()}`,
                  profile.rules.length === 0
                    ? ""
                    : `Rules:\n${profile.rules.map((rule) => `- ${rule}`).join("\n")}`,
                ]
                  .filter((part) => part !== "")
                  .join("\n\n");
              }
              const about = a.about?.trim();
              const rules = a.rules?.map((rule) => rule.trim()).filter((rule) => rule !== "");
              if (about === undefined && rules === undefined) {
                return yield* new ToolError({ reason: "update needs about, rules, or both" });
              }
              if (about !== undefined && about.length > 4_000) {
                return yield* new ToolError({ reason: "about is longer than 4,000 characters" });
              }
              if (rules !== undefined && rules.length > 20) {
                return yield* new ToolError({ reason: "keep rules to 20 entries or fewer" });
              }
              const saved = yield* host.updateProfile(about, rules);
              return `Profile saved: ${saved.about === "" ? "no about" : "about"}, ${saved.rules.length} rule(s).`;
            });
          case "policy_manage":
            return Effect.gen(function* () {
              const a = yield* decode(PolicyArgs, args);
              switch (a.action) {
                case "list": {
                  const all = yield* policies.list;
                  return all.length === 0
                    ? "No policies."
                    : all
                        .map((policy) => `#${policy.id} ${policy.decision} ${policy.match}`)
                        .join("\n");
                }
                case "add": {
                  const match = a.match?.trim().toLowerCase() ?? "";
                  if (match === "") return yield* new ToolError({ reason: "add needs a match" });
                  if (match.length > 200) {
                    return yield* new ToolError({ reason: "match is longer than 200 characters" });
                  }
                  if (a.decision === undefined) {
                    return yield* new ToolError({ reason: "add needs a decision" });
                  }
                  const made = yield* policies.add(match, a.decision);
                  return `Policy #${made.id}: ${made.decision} ${made.match}.`;
                }
                case "remove": {
                  if (a.id === undefined)
                    return yield* new ToolError({ reason: "remove needs an id" });
                  return (yield* policies.remove(a.id))
                    ? `Removed policy #${a.id}.`
                    : `No policy #${a.id}.`;
                }
              }
            });
          case "executor":
            return Effect.gen(function* () {
              const a = yield* decode(ExecutorArgs, args);
              const input = yield* Effect.try({
                try: () => JSON.parse(a.input) as unknown,
                catch: () => new ToolError({ reason: "input is not valid JSON" }),
              });
              if (typeof input !== "object" || input === null || Array.isArray(input)) {
                return yield* new ToolError({ reason: "input must be a JSON object" });
              }
              const call = input as Record<string, unknown>;
              const target = targetOf(a.tool, call);
              const decision = yield* policies.decide(target);
              if (decision === "deny") {
                return yield* new ToolError({ reason: `a policy denies ${target}` });
              }
              const out = yield* executor.call(a.tool, call);
              const paused = pausedExecution(out);
              if (!paused) return clipToolOutput(out);
              if (decision === "allow") {
                const resumed = yield* executor.call("resume", {
                  executionId: paused.executionId,
                  action: "accept",
                });
                return clipToolOutput(resumed);
              }
              yield* approvals.add(paused.executionId, paused.summary, target);
              return "Waiting for the user's approval. They have been shown Approve, Always allow and Deny buttons.";
            });
          case "artifact_publish":
            return Effect.gen(function* () {
              const a = yield* decode(ArtifactPublishArgs, args);
              const contentType = a.content_type ?? KIND_TYPES[a.kind ?? "html"];
              const made = yield* artifacts.publish(
                yield* channel,
                a.name,
                a.content,
                contentType,
                a.expires_in_hours ? { expiresInHours: a.expires_in_hours } : {},
              );
              return `Published v${made.version}: ${made.url}`;
            });
          case "artifact_data":
            return Effect.gen(function* () {
              const a = yield* decode(ArtifactDataArgs, args);
              const need = (v: string | undefined, what: string) =>
                v === undefined
                  ? Effect.fail(new ToolError({ reason: `${a.action} needs ${what}` }))
                  : Effect.succeed(v);
              switch (a.action) {
                case "list": {
                  const all = yield* artifacts.data.list(a.name);
                  return Object.keys(all).length === 0
                    ? "No data saved."
                    : clipToolOutput(JSON.stringify(all, null, 1));
                }
                case "get":
                  return (
                    (yield* artifacts.data.get(a.name, yield* need(a.key, "`key`"))) ??
                    "No such key."
                  );
                case "set":
                  yield* artifacts.data.set(
                    a.name,
                    yield* need(a.key, "`key`"),
                    yield* need(a.value, "`value`"),
                  );
                  return "Saved.";
                case "delete":
                  yield* artifacts.data.delete(a.name, yield* need(a.key, "`key`"));
                  return "Deleted.";
              }
            });
          case "artifact_history":
            return Effect.gen(function* () {
              const a = yield* decode(ArtifactHistoryArgs, args);
              const versions = yield* artifacts.history(yield* channel, a.name);
              return versions.length === 0
                ? `No versions of ${a.name}.`
                : `${a.name}: versions ${versions.join(", ")}.`;
            });
          case "artifact_restore":
            return Effect.gen(function* () {
              const a = yield* decode(ArtifactRestoreArgs, args);
              const made = yield* artifacts.restore(yield* channel, a.name, a.version);
              return `Restored as v${made.version}: ${made.url}`;
            });
          case "artifact_list":
            return Effect.map(artifacts.list, (all) =>
              all.length === 0
                ? "No artifacts."
                : all.map((a) => `${a.name} v${a.version} ${a.url}`).join("\n"),
            );
          case "artifact_delete":
            return Effect.gen(function* () {
              const a = yield* decode(ArtifactDeleteArgs, args);
              return (yield* artifacts.remove(yield* channel, a.name))
                ? `Took down ${a.name}.`
                : `No artifact ${a.name}.`;
            });
          case "send_to_user":
            return Effect.gen(function* () {
              const a = yield* decode(SendToUserArgs, args);
              const threadId = yield* state.meta("thread");
              if (!threadId) return yield* new ToolError({ reason: "no chat to send to yet" });
              const texts = a.messages.map((m) => m.trim()).filter((m) => m !== "");
              yield* outbox.send(threadId, texts);
              return `Sent ${texts.length}.`;
            });
          case "web_search":
            return Effect.flatMap(decode(WebSearchArgs, args), (a) => web.search(a.query));
          case "web_fetch":
            return Effect.flatMap(decode(WebFetchArgs, args), (a) =>
              Effect.map(
                web.fetch(a.url),
                (page) =>
                  `${page.status} ${page.contentType}${page.truncated ? " (cut)" : ""}\n${clipToolOutput(page.text)}`,
              ),
            );
          case "skill_manage":
            return Effect.gen(function* () {
              const a = yield* decode(SkillArgs, args);
              switch (a.action) {
                case "list": {
                  const all = yield* skills.list;
                  return all.length === 0
                    ? "No skills yet."
                    : all
                        .map(
                          (skill) =>
                            `- ${skill.name}: ${skill.description}${skill.pinned ? " (pinned)" : ""}`,
                        )
                        .join("\n");
                }
                case "read": {
                  if (!a.name) return yield* new ToolError({ reason: "read needs a name" });
                  const skill = yield* skills.get(a.name);
                  if (!skill) return yield* new ToolError({ reason: `no skill "${a.name}"` });
                  yield* skills.touch(a.name);
                  return `# ${skill.name}\n${skill.description}\n\n${skill.body}`;
                }
                case "save": {
                  if (!a.name || !a.description || !a.body) {
                    return yield* new ToolError({
                      reason: "save needs name, description and body",
                    });
                  }
                  const name = a.name.trim();
                  const description = a.description.trim();
                  const body = a.body.trim();
                  if (!SKILL_NAME.test(name)) {
                    return yield* new ToolError({
                      reason: "name: lowercase letters, digits and dashes, up to 64",
                    });
                  }
                  if (description.length > MAX_SKILL_DESCRIPTION) {
                    return yield* new ToolError({
                      reason: `description is longer than ${MAX_SKILL_DESCRIPTION} characters`,
                    });
                  }
                  if (body.length > MAX_SKILL_BODY) {
                    return yield* new ToolError({
                      reason: `body is longer than ${MAX_SKILL_BODY} characters`,
                    });
                  }
                  const saved = yield* skills.save(name, description, body);
                  return `Saved skill "${saved.name}".`;
                }
                case "delete": {
                  if (!a.name) return yield* new ToolError({ reason: "delete needs a name" });
                  const skill = yield* skills.get(a.name);
                  if (!skill) return `No skill "${a.name}".`;
                  if (skill.pinned) {
                    return yield* new ToolError({
                      reason: `"${a.name}" is pinned by a schedule; cancel the schedule first`,
                    });
                  }
                  return (yield* skills.remove(a.name))
                    ? `Deleted skill "${a.name}".`
                    : `No skill "${a.name}".`;
                }
              }
            });
          case "intent_manage":
            return Effect.gen(function* () {
              const a = yield* decode(IntentArgs, args);
              switch (a.action) {
                case "create": {
                  const description = a.description?.trim() ?? "";
                  const triggers = (a.triggers ?? [])
                    .map((trigger) => trigger.trim())
                    .filter((trigger) => trigger !== "");
                  if (description === "") {
                    return yield* new ToolError({ reason: "create needs a description" });
                  }
                  if (triggers.length === 0) {
                    return yield* new ToolError({ reason: "create needs at least one trigger" });
                  }
                  if (description.length > MAX_INTENT_DESCRIPTION) {
                    return yield* new ToolError({
                      reason: `description is longer than ${MAX_INTENT_DESCRIPTION} characters`,
                    });
                  }
                  if (triggers.length > MAX_INTENT_TRIGGERS) {
                    return yield* new ToolError({
                      reason: `keep triggers to ${MAX_INTENT_TRIGGERS} or fewer`,
                    });
                  }
                  const long = triggers.find((trigger) => trigger.length > MAX_TRIGGER_LENGTH);
                  if (long !== undefined) {
                    return yield* new ToolError({
                      reason: `trigger "${long}" is longer than ${MAX_TRIGGER_LENGTH} characters`,
                    });
                  }
                  const days = a.days ?? 90;
                  const made = yield* intents.create(description, triggers, {
                    expiresAt: Date.now() + days * 86_400_000,
                    cooldownMs: (a.cooldown_hours ?? 24) * 3_600_000,
                    maxFires: a.max_fires ?? 3,
                  });
                  return `Standing intent #${made.id} armed for: ${triggers.join(", ")}.`;
                }
                case "list": {
                  const all = yield* intents.list;
                  return all.length === 0
                    ? "No standing intents."
                    : all
                        .map(
                          (intent) =>
                            `#${intent.id} ${intent.state} [${intent.triggers.join(", ")}] ${intent.description} (fires ${intent.fireCount}/${intent.maxFires}, expires ${formatDate(new Date(intent.expires), timezone)})`,
                        )
                        .join("\n");
                }
                case "cancel": {
                  if (a.id === undefined) {
                    return yield* new ToolError({ reason: "cancel needs an id" });
                  }
                  return (yield* intents.cancel(a.id))
                    ? `Cancelled #${a.id}.`
                    : `No armed intent #${a.id}.`;
                }
              }
            });
          case "schedule_create":
            return Effect.gen(function* () {
              const a = yield* decode(ScheduleCreateArgs, args);
              const spec = yield* specOf(a);
              const now = new Date(DateTime.toEpochMillis(yield* DateTime.now));
              const skill = a.skill?.trim();
              if (skill !== undefined && skill !== "") {
                if (!SKILL_NAME.test(skill)) {
                  return yield* new ToolError({ reason: `"${skill}" is not a skill name` });
                }
                const found = yield* skills.get(skill);
                if (!found) return yield* new ToolError({ reason: `no skill "${skill}"` });
                yield* skills.pin(skill);
              }
              const made = yield* schedules.create(
                spec,
                a.prompt,
                now,
                skill === "" ? undefined : skill,
              );
              return `Scheduled. ${describe(made)}`;
            });
          case "schedule_list":
            return Effect.map(schedules.list, (all) =>
              all.length === 0 ? "No schedules." : all.map(describe).join("\n"),
            );
          case "schedule_cancel":
            return Effect.flatMap(decode(ScheduleCancelArgs, args), ({ id }) =>
              Effect.map(schedules.cancel(id), (done) =>
                done ? `Cancelled #${id}.` : `No active schedule #${id}.`,
              ),
            );
          default:
            return Effect.succeed(`No tool ${name}.`);
        }
      };

      // A failure becomes text the agent reads and can act on; it never fails the turn.
      return Handlers.of({
        call: (name, args) =>
          run(name, args).pipe(Effect.catch((error) => Effect.succeed(`Error: ${error.message}`))),
      });
    }),
  );
}
