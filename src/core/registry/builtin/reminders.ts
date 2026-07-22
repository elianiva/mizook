import { ToolDefinition } from "../types";

export const remindersToolDefinition = new ToolDefinition({
  name: "reminders",
  description:
    "Manage reminders (set, list, delete). Supports one-time delays and recurring cron schedules.",
  domain: "reminders",
});
