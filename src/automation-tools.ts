import { Effect, Schema } from "effect";
import type { Automation } from "./automations.ts";
import { Settings } from "./config.ts";
import { ScheduleError, ToolError } from "./errors.ts";
import { formatDate } from "./format.ts";
import { Agents, AutomationsClient, GlobalSkills, Self } from "./host.ts";
import { describeAutomation } from "./runner.ts";
import type { Spec } from "./schedule.ts";
import { Skills } from "./skills.ts";
import { defineTool, described } from "./tool.ts";

export const AutomationCreateArgs = Schema.Struct({
  trigger: described(
    Schema.Literals(["once", "cron", "watch", "webhook"]),
    "once: one time. cron: on a recurring schedule. watch: poll a URL and fire only when it changes. webhook: fire when something POSTs to the link it gives back.",
  ),
  at: Schema.optionalKey(
    described(
      Schema.String,
      "once: the time, ISO 8601 with the UTC offset, e.g. 2026-11-16T09:00:00+07:00. Work it out from Now.",
    ),
  ),
  cron: Schema.optionalKey(
    described(
      Schema.String,
      "cron: a 5-field cron expression in the user's time zone, e.g. 0 9 * * 1-5.",
    ),
  ),
  url: Schema.optionalKey(described(Schema.String, "watch: the http(s) URL to poll.")),
  every_minutes: Schema.optionalKey(
    described(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(5)),
      "watch: minutes between polls, at least 5.",
    ),
  ),
  action: Schema.optionalKey(
    described(
      Schema.Literals(["turn", "post", "webhook"]),
      "turn (default): an agent gets the prompt as a message and answers. post: send text as is, no model. webhook: call an outside URL.",
    ),
  ),
  prompt: Schema.optionalKey(
    described(
      Schema.String,
      "turn: what to do, as an instruction to the agent. It arrives as a message starting [automation #id], with the watch's page or the webhook's body after it.",
    ),
  ),
  text: Schema.optionalKey(described(Schema.String, "post: the message to send.")),
  skill: Schema.optionalKey(
    described(
      Schema.String,
      "turn: a skill the agent reads first. It stays pinned while the automation exists.",
    ),
  ),
  agent: Schema.optionalKey(
    described(Schema.String, "turn and post: the agent's slug. Default: you."),
  ),
  place: Schema.optionalKey(
    described(
      Schema.String,
      'turn and post: where it talks, a place id. Default: here. "last" is wherever that agent talked last.',
    ),
  ),
  call_url: Schema.optionalKey(described(Schema.String, "webhook action: the https URL to call.")),
  method: Schema.optionalKey(
    described(Schema.Literals(["GET", "POST", "PUT"]), "webhook action: default POST."),
  ),
  body: Schema.optionalKey(
    described(
      Schema.String,
      "webhook action: the JSON body. {{payload}} becomes what the trigger brought, as a JSON string's contents.",
    ),
  ),
});

export const AutomationIdArgs = Schema.Struct({
  id: described(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    "The automation's number, from automations.list.",
  ),
});

const specOf = (
  a: typeof AutomationCreateArgs.Type,
  timezone: string,
): Effect.Effect<Spec, ScheduleError> => {
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

const agentIdBySlugDefaultingToSelf = (slug: string | undefined) =>
  Effect.gen(function* () {
    const self = yield* Self;
    const wanted = slug?.trim().replace(/^\//, "").toLowerCase();
    if (!wanted || wanted === self.slug) return self.id;
    const found = (yield* (yield* Agents).all).find((x) => x.slug === wanted);
    if (!found) return yield* new ToolError({ reason: `no agent "${slug}"` });
    return found.id;
  });

const oneLineWithWebhookLink = (a: Automation) =>
  Effect.gen(function* () {
    const { timezone } = yield* Settings;
    const agents = yield* (yield* Agents).all;
    const line = describeAutomation(
      a,
      (at) => formatDate(new Date(at), timezone),
      (id) => `/${agents.find((x) => x.id === id)?.slug ?? id}`,
    );
    return a.spec.kind === "webhook"
      ? `${line}\n  link: ${yield* (yield* AutomationsClient).hookUrl(a.id)}`
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
          const skills = yield* Skills;
          const globalSkills = yield* GlobalSkills;
          if (yield* skills.get(skill)) yield* skills.pin(skill);
          else if (yield* globalSkills.get(skill)) yield* globalSkills.pin(skill);
          else return yield* new ToolError({ reason: `no skill "${skill}"` });
        }
        return {
          kind: "turn" as const,
          agent: yield* agentIdBySlugDefaultingToSelf(a.agent),
          place: where,
          prompt,
          ...(skill ? { skill } : {}),
        };
      }
      case "post": {
        const text = a.text?.trim();
        if (!text) return yield* new ToolError({ reason: "a post needs text" });
        return {
          kind: "post" as const,
          agent: yield* agentIdBySlugDefaultingToSelf(a.agent),
          place: where,
          text,
        };
      }
      case "webhook": {
        if (!a.call_url) return yield* new ToolError({ reason: "a webhook action needs call_url" });
        return {
          kind: "webhook" as const,
          url: a.call_url,
          method: a.method ?? "POST",
          ...(a.body === undefined ? {} : { body: a.body }),
        };
      }
    }
  });

export const automationTools = [
  defineTool({
    name: "automation_create",
    path: "automations.create",
    description:
      "Make something happen later or on an event: a trigger (a time, a cron, a watched URL, a webhook call) and an action (a turn of you or another agent, a fixed message, or a call to a URL).",
    args: AutomationCreateArgs,
    run: (a, place) =>
      Effect.gen(function* () {
        const spec = yield* specOf(a, (yield* Settings).timezone);
        const action = yield* actionOf(a, place);
        const made = yield* (yield* AutomationsClient).create(spec, action);
        return `Automation made. ${yield* oneLineWithWebhookLink(made)}`;
      }),
  }),
  defineTool({
    name: "automation_list",
    path: "automations.list",
    description:
      "List the automations that act for you, with their numbers, triggers, next times and webhook links.",
    args: Schema.Struct({}),
    run: () =>
      Effect.gen(function* () {
        const self = yield* Self;
        const all = yield* (yield* AutomationsClient).list(self.id);
        if (all.length === 0) return "No automations.";
        return (yield* Effect.forEach(all, oneLineWithWebhookLink)).join("\n");
      }),
  }),
  defineTool({
    name: "automation_cancel",
    path: "automations.cancel",
    description: "Delete an automation by its number.",
    args: AutomationIdArgs,
    run: ({ id }) =>
      AutomationsClient.use((automations) =>
        Effect.map(automations.cancel(id), (done) =>
          done ? `Deleted #${id}.` : `No automation #${id}.`,
        ),
      ),
  }),
  defineTool({
    name: "automation_pause",
    path: "automations.pause",
    description: "Pause an automation. It keeps its trigger and action and can be resumed.",
    args: AutomationIdArgs,
    run: ({ id }) =>
      AutomationsClient.use((automations) =>
        Effect.map(automations.pause(id), (done) =>
          done ? `Paused #${id}.` : `No active automation #${id}.`,
        ),
      ),
  }),
  defineTool({
    name: "automation_resume",
    path: "automations.resume",
    description: "Resume a paused automation from its next time.",
    args: AutomationIdArgs,
    run: ({ id }) =>
      AutomationsClient.use((automations) =>
        Effect.map(automations.resume(id), (done) =>
          done ? `Resumed #${id}.` : `No automation #${id}.`,
        ),
      ),
  }),
  defineTool({
    name: "automation_test",
    path: "automations.test",
    description:
      "Fire an automation now, in the background, whatever its trigger. Its next time stays as it was.",
    args: AutomationIdArgs,
    run: ({ id }) =>
      AutomationsClient.use((automations) =>
        Effect.map(automations.test(id), (started) =>
          started
            ? `Test #${id} started; the result goes where it talks.`
            : `No automation #${id}.`,
        ),
      ),
  }),
];
