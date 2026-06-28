import type { ChatTarget } from "../../core/channel";

export interface ReminderPayload {
  target: ChatTarget;
  message: string;
}

export function parseDurationToSeconds(duration: string): number | null {
  const match = duration.match(/^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)?$/i);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  const unit = (match[2] || "m").toLowerCase()[0];
  switch (unit) {
    case "s": return num;
    case "m": return num * 60;
    case "h": return num * 3600;
    case "d": return num * 86400;
    default: return null;
  }
}

import { tool } from "ai";
import { z } from "zod";
import type { MizookAgent } from "../../core/agent";

export function createReminderTools(agent: MizookAgent) {
  const tz = agent.getConfiguredTimezone();

  return {
    set_reminder: tool({
      description:
        "Set a reminder. By default creates a ONE-TIME reminder that fires after a delay. " +
        "Only use the cron field for RECURRING reminders (daily, weekly, etc.). " +
        `CRON EXPRESSIONS MUST BE IN UTC. Convert from user's local time (${tz}) to UTC. ` +
        "Example: 'remind me in 30 minutes' -> duration: '30m', cron: omitted. " +
        "Example: 'every day at 8am' -> cron with appropriate UTC hour, duration: omitted.",
      inputSchema: z.object({
        message: z.string().describe("The reminder message text"),
        duration: z.string().optional().describe(
          "For ONE-TIME reminders: how long from now (e.g. '30m', '2h', '1d'). Omit for recurring.",
        ),
        cron: z.string().optional().describe(
          "For RECURRING reminders only: cron expression in UTC. Convert from local time to UTC. Do not use for one-time.",
        ),
      }),
      execute: async ({ message, duration, cron }) => {
        const turn = agent.getTurnState();
        if (!turn) return "Reminders are only available during a conversation turn.";

        const payload: ReminderPayload = {
          target: { platform: turn.channelType, chatId: turn.chatId },
          message,
        };

        if (cron) {
          const schedule = await agent.schedule(cron, "sendReminder", payload);
          return `Recurring reminder set. ID: ${schedule.id}. I will remind you: "${message}"`;
        }

        const seconds = duration ? parseDurationToSeconds(duration) : 60;
        if (seconds === null) {
          return `Could not parse duration "${duration}". Use e.g. '30m', '2h', '1d'.`;
        }

        const schedule = await agent.schedule(seconds, "sendReminder", payload);
        const mins = Math.round(seconds / 60);
        return `One-time reminder set. ID: ${schedule.id}. "${message}" in ${mins} minute${mins === 1 ? "" : "s"}.`;
      },
    }),

    list_reminders: tool({
      description: "List all active reminders",
      inputSchema: z.object({}),
      execute: async () => {
        const all = await agent.listSchedules();
        const reminders = all.filter((s) => s.callback === "sendReminder");
        if (reminders.length === 0) return "No active reminders.";

        return reminders
          .map((s) => {
            const p = s.payload as ReminderPayload;
            const next = new Date(s.time * 1000).toLocaleString("en-ID", {
              timeZone: agent.getConfiguredTimezone(),
              weekday: "short",
              hour: "2-digit",
              minute: "2-digit",
              day: "numeric",
              month: "short",
            });
            const kind = s.type === "cron" && "cron" in s
              ? `cron: ${(s as typeof s & { cron: string }).cron}`
              : s.type;
            return `ID: ${s.id} | ${p.message} — next: ${next} (${kind})`;
          })
          .join("\n");
      },
    }),

    delete_reminder: tool({
      description: "Cancel a reminder by its ID",
      inputSchema: z.object({
        scheduleId: z.string().describe("The schedule ID of the reminder to cancel"),
      }),
      execute: async ({ scheduleId }) => {
        const cancelled = await agent.cancelSchedule(scheduleId);
        return cancelled
          ? "Reminder cancelled."
          : `Reminder not found (ID: ${scheduleId}). Use list_reminders.`;
      },
    }),
  };
}
