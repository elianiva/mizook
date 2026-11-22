import { clipToolOutput, Memory } from "@mizook/memory";
import { Context, Effect, Layer, Schema } from "effect";
import { Browser } from "./browser.ts";
import { Settings } from "./config.ts";
import { ScheduleError } from "./errors.ts";
import { formatDate } from "./format.ts";
import {
  Intents,
  MAX_INTENT_DESCRIPTION,
  MAX_INTENT_TRIGGERS,
  MAX_TRIGGER_LENGTH,
} from "./intents.ts";
import { MEDIA_LABEL, Media } from "./media.ts";
import { Policies } from "./policies.ts";
import type { Automation } from "./automations.ts";
import { describeAutomation } from "./runner.ts";
import type { Spec } from "./schedule.ts";
import { MAX_SKILL_BODY, MAX_SKILL_DESCRIPTION, SKILL_NAME, Skills } from "./skills.ts";
import { KIND_TYPES } from "./artifact-render.ts";
import { Artifacts } from "./artifacts.ts";
import { Blobs } from "./blobs.ts";
import { Approvals } from "./approvals.ts";
import { Executor, pausedExecution } from "./executor.ts";
import { Host } from "./host.ts";
import { describeAgentAction, encodeAgentAction, type AgentAction } from "./agent-manage.ts";
import { ToolError } from "./errors.ts";
import { Outbox } from "./outbox.ts";
import { Web } from "./search.ts";
import {
  AskAgentArgs,
  AgentManageArgs,
  FileReadArgs,
  SendToUserArgs,
  ExecutorArgs,
  ArtifactDataArgs,
  ArtifactDeleteArgs,
  ArtifactHistoryArgs,
  ArtifactRestoreArgs,
  ArtifactPublishArgs,
  BrowserReadArgs,
  DateArgs,
  IntentArgs,
  PolicyArgs,
  ProfileArgs,
  AutomationCreateArgs,
  AutomationIdArgs,
  SearchArgs,
  SkillArgs,
  WebFetchArgs,
  WebSearchArgs,
  ZoomArgs,
} from "./tools.ts";
import { toolPaths } from "./codemode.ts";

/** What a tool does, by name. The arguments were already checked against the tool's schema. */
export class Handlers extends Context.Service<
  Handlers,
  {
    /** `place` is where the turn that called it is talking; undefined outside a turn. */
    call(name: string, args: unknown, place: string | undefined): Effect.Effect<string>;
    /** The same, failing with what went wrong instead of answering with it. */
    run(
      name: string,
      args: unknown,
      place: string | undefined,
    ): Effect.Effect<string, { readonly message: string }>;
  }
>()("mizook/Handlers") {
  static readonly layer = Layer.effect(
    Handlers,
    Effect.gen(function* () {
      const memory = yield* Memory;
      const intents = yield* Intents;
      const policies = yield* Policies;
      const skills = yield* Skills;
      const media = yield* Media;
      const browser = yield* Browser;
      const web = yield* Web;
      const outbox = yield* Outbox;
      const executor = yield* Executor;
      const host = yield* Host;
      const approvals = yield* Approvals;
      const blobs = yield* Blobs;
      const artifacts = yield* Artifacts;
      const channel = Effect.succeed(host.self.doName);
      const { timezone } = yield* Settings;

      const specOf = (a: typeof AutomationCreateArgs.Type): Effect.Effect<Spec, ScheduleError> => {
        const missing = (what: string) => Effect.fail(new ScheduleError({ reason: what }));
        switch (a.trigger) {
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
          case "webhook":
            return Effect.succeed({ kind: "webhook" });
        }
      };

      /** The agent an action names by slug, as its id; you by default. */
      const agentId = (slug: string | undefined) =>
        Effect.gen(function* () {
          const wanted = slug?.trim().replace(/^\//, "").toLowerCase();
          if (!wanted || wanted === host.self.slug) return host.self.id;
          const found = (yield* host.agents).find((x) => x.slug === wanted);
          if (!found) return yield* new ToolError({ reason: `no agent "${slug}"` });
          return found.id;
        });

      /** An automation in one line, with its webhook link when it has one. */
      const describe = (a: Automation) =>
        Effect.gen(function* () {
          const agents = yield* host.agents;
          const line = describeAutomation(
            a,
            (at) => formatDate(new Date(at), timezone),
            (id) => `/${agents.find((x) => x.id === id)?.slug ?? id}`,
          );
          return a.spec.kind === "webhook"
            ? `${line}\n  link: ${yield* host.automations.hookUrl(a.id)}`
            : line;
        });

      const actionOf = (a: typeof AutomationCreateArgs.Type, place: string | undefined) =>
        Effect.gen(function* () {
          const where = a.place === "last" ? "" : (a.place ?? place ?? "");
          switch (a.action ?? "turn") {
            case "turn": {
              const prompt = a.prompt?.trim();
              if (!prompt) return yield* new ToolError({ reason: "a turn needs a prompt" });
              const skill = a.skill?.trim();
              if (skill) {
                if (!SKILL_NAME.test(skill)) {
                  return yield* new ToolError({ reason: `"${skill}" is not a skill name` });
                }
                // An automation needs its skill: keep it, yours first, then the shared one.
                if (yield* skills.get(skill)) yield* skills.pin(skill);
                else if (yield* host.globalSkills.get(skill)) yield* host.globalSkills.pin(skill);
                else return yield* new ToolError({ reason: `no skill "${skill}"` });
              }
              return {
                kind: "turn" as const,
                agent: yield* agentId(a.agent),
                place: where,
                prompt,
                ...(skill ? { skill } : {}),
              };
            }
            case "post": {
              const text = a.text?.trim();
              if (!text) return yield* new ToolError({ reason: "a post needs text" });
              return { kind: "post" as const, agent: yield* agentId(a.agent), place: where, text };
            }
            case "webhook": {
              if (!a.call_url)
                return yield* new ToolError({ reason: "a webhook action needs call_url" });
              return {
                kind: "webhook" as const,
                url: a.call_url,
                method: a.method ?? "POST",
                ...(a.body === undefined ? {} : { body: a.body }),
              };
            }
          }
        });

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
        place: string | undefined,
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
              if (textual) return clipToolOutput(new TextDecoder().decode(blob.body));
              const extracted = yield* media
                .extract({
                  bytes: blob.body,
                  contentType: blob.contentType,
                  name: a.key.split("/").at(-1) ?? a.key,
                })
                .pipe(
                  Effect.catch((error) =>
                    Effect.logWarning(`media ${a.key} failed: ${error.message}`).pipe(
                      Effect.as(undefined),
                    ),
                  ),
                );
              return extracted === undefined
                ? `Binary file: ${blob.contentType}, ${blob.body.length} bytes. I cannot read its content.`
                : `${MEDIA_LABEL[extracted.kind]}:\n${clipToolOutput(extracted.text, 16_000)}`;
            });
          case "ask_agent":
            return Effect.flatMap(decode(AskAgentArgs, args), (a) => host.ask(a.agent, a.question));
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
              const call = a.input;
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
              yield* approvals.add(paused.executionId, paused.summary, target, place ?? "");
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
              if (!place) return yield* new ToolError({ reason: "no chat to send to here" });
              const texts = a.messages.map((m) => m.trim()).filter((m) => m !== "");
              yield* outbox.send(place, texts);
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
          case "browser_read":
            return Effect.gen(function* () {
              const a = yield* decode(BrowserReadArgs, args);
              const page = yield* browser.read(a.url);
              const body =
                page.text === ""
                  ? "The page loaded but had no readable text."
                  : clipToolOutput(page.text, 20_000);
              const heading = page.title ? `${page.title}\n\n` : "";
              if (!page.screenshot) return `${heading}${body}`;
              const shot = yield* artifacts
                .publishBytes(yield* channel, `browser-${Date.now()}`, page.screenshot, "image/png")
                .pipe(
                  Effect.catch((error) =>
                    Effect.logWarning(`browser screenshot failed: ${error.message}`).pipe(
                      Effect.as(undefined),
                    ),
                  ),
                );
              return `${heading}${body}${shot ? `\n\nScreenshot: ${shot.url}` : ""}`;
            });
          case "skill_manage":
            return Effect.gen(function* () {
              const a = yield* decode(SkillArgs, args);
              const global = host.globalSkills;
              /** The skill by name: yours first, then the shared one, unless a scope is given. */
              const find = (name: string) =>
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
                  const found = yield* find(a.name);
                  if (!found) return yield* new ToolError({ reason: `no skill "${a.name}"` });
                  yield* found.store.touch(a.name);
                  return `# ${found.skill.name}\n${found.skill.description}\n\n${found.skill.body}`;
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
                  const store = a.scope === "global" ? global : skills;
                  const saved = yield* store.save(name, description, body);
                  return `Saved ${a.scope === "global" ? "global " : ""}skill "${saved.name}".`;
                }
                case "delete": {
                  if (!a.name) return yield* new ToolError({ reason: "delete needs a name" });
                  const found = yield* find(a.name);
                  if (!found) return `No skill "${a.name}".`;
                  if (found.skill.pinned) {
                    return yield* new ToolError({
                      reason: `"${a.name}" is pinned by an automation; cancel the automation first`,
                    });
                  }
                  return (yield* found.store.remove(a.name))
                    ? `Deleted ${found.scope === "global" ? "global " : ""}skill "${a.name}".`
                    : `No skill "${a.name}".`;
                }
              }
            });
          case "agent_manage":
            return Effect.gen(function* () {
              const a = yield* decode(AgentManageArgs, args);
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
              const known = new Set([...toolPaths, ...toolPaths.map((p) => p.split(".")[0])]);
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
              yield* approvals.add(
                "",
                describeAgentAction(action),
                "",
                place ?? "",
                encodeAgentAction(action),
              );
              return "Waiting for the user's approval. They have been shown Approve and Deny buttons.";
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
          case "automation_create":
            return Effect.gen(function* () {
              const a = yield* decode(AutomationCreateArgs, args);
              const spec = yield* specOf(a);
              const action = yield* actionOf(a, place);
              const made = yield* host.automations.create(spec, action);
              return `Automation made. ${yield* describe(made)}`;
            });
          case "automation_list":
            return Effect.gen(function* () {
              const all = yield* host.automations.list(host.self.id);
              if (all.length === 0) return "No automations.";
              return (yield* Effect.forEach(all, describe)).join("\n");
            });
          case "automation_cancel":
            return Effect.flatMap(decode(AutomationIdArgs, args), ({ id }) =>
              Effect.map(host.automations.cancel(id), (done) =>
                done ? `Deleted #${id}.` : `No automation #${id}.`,
              ),
            );
          case "automation_pause":
            return Effect.flatMap(decode(AutomationIdArgs, args), ({ id }) =>
              Effect.map(host.automations.pause(id), (done) =>
                done ? `Paused #${id}.` : `No active automation #${id}.`,
              ),
            );
          case "automation_resume":
            return Effect.flatMap(decode(AutomationIdArgs, args), ({ id }) =>
              Effect.map(host.automations.resume(id), (done) =>
                done ? `Resumed #${id}.` : `No automation #${id}.`,
              ),
            );
          case "automation_test":
            return Effect.flatMap(decode(AutomationIdArgs, args), ({ id }) =>
              Effect.map(host.automations.test(id), (started) =>
                started
                  ? `Test #${id} started; the result goes where it talks.`
                  : `No automation #${id}.`,
              ),
            );
          default:
            return Effect.fail(new ToolError({ reason: `no tool ${name}` }));
        }
      };

      // A failure becomes text the agent reads and can act on; it never fails the turn.
      return Handlers.of({
        run,
        call: (name, args, place) =>
          run(name, args, place).pipe(
            Effect.catch((error) => Effect.succeed(`Error: ${error.message}`)),
          ),
      });
    }),
  );
}
