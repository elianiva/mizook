import { StringEnum } from "@earendil-works/pi-ai/utils/typebox-helpers";
import { Type, type Tool } from "@earendil-works/pi-ai";

/**
 * Every tool the agent has. Compactions send the same list (never called) so they read the turns'
 * prompt cache: tools and system prompt must be the same bytes in both. Add a tool here, give it a
 * handler in `handlers.ts`, and both see it.
 */
export const zoomParameters = Type.Object({
  id: Type.Integer({ minimum: 0, description: "First message of the line, as in id+n." }),
  n: Type.Integer({
    minimum: 1,
    description: "Messages the line covers: a power of 2, and id a multiple of it.",
  }),
});

export const dateParameters = Type.Object({
  id: Type.Integer({ minimum: 0, description: "The message id." }),
});

export const scheduleCreateParameters = Type.Object({
  kind: StringEnum(["once", "cron", "watch"], {
    description:
      "once: fire one time. cron: fire on a recurring schedule. watch: poll a URL and fire only when its content changes.",
  }),
  prompt: Type.String({
    description:
      "What to do when it fires, written as an instruction to yourself. You will see it as a message starting [scheduled #id].",
  }),
  at: Type.Optional(
    Type.String({
      description:
        "once: the time, ISO 8601 with the UTC offset, e.g. 2026-11-16T09:00:00+07:00. Work it out from Now.",
    }),
  ),
  cron: Type.Optional(
    Type.String({
      description: "cron: a 5-field cron expression in the chat's time zone, e.g. 0 9 * * 1-5.",
    }),
  ),
  url: Type.Optional(Type.String({ description: "watch: the http(s) URL to poll." })),
  every_minutes: Type.Optional(
    Type.Integer({ minimum: 5, description: "watch: minutes between polls, at least 5." }),
  ),
});

export const scheduleCancelParameters = Type.Object({
  id: Type.Integer({ minimum: 1, description: "The schedule number, from schedule_list." }),
});

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Tool["parameters"];
  /** `unsafe`: running it twice has an effect, so a restart must not replay it. */
  readonly replay: "safe" | "unsafe";
}

export const ZOOM_DESCRIPTION =
  "Open line id+n of the view into the two lines it was made from. zoom(id, 1) gives message id whole.";
export const DATE_DESCRIPTION = "The date and time of message id.";

export const toolSpecs: ReadonlyArray<ToolSpec> = [
  { name: "zoom", description: ZOOM_DESCRIPTION, parameters: zoomParameters, replay: "safe" },
  { name: "date", description: DATE_DESCRIPTION, parameters: dateParameters, replay: "safe" },
  {
    name: "schedule_create",
    description:
      "Wake this chat later: a one-off reminder, a recurring job, or a watch on a URL. When it fires you get a new turn with your prompt.",
    parameters: scheduleCreateParameters,
    replay: "unsafe",
  },
  {
    name: "schedule_list",
    description: "List this chat's active schedules with their numbers and next times.",
    parameters: Type.Object({}),
    replay: "safe",
  },
  {
    name: "schedule_cancel",
    description: "Cancel a schedule by its number.",
    parameters: scheduleCancelParameters,
    replay: "unsafe",
  },
];

export const agentTools: Tool[] = toolSpecs.map(({ name, description, parameters }) => ({
  name,
  description,
  parameters,
}));

/** Appended to the system prompt, before the user's instructions. Static: no dates or state. */
export const TOOL_GUIDE = `# Scheduling

You can wake this chat later with schedule_create. Use "once" for a reminder at a time, "cron" for a
recurring job, and "watch" to poll a URL and be woken only when it changes. When one fires you get a
message starting [scheduled #id] or [watch #id changed] and the reply goes to the user. Work out times from
Now, which starts every message. Confirm to the user what you scheduled and when, in their time zone.`;
