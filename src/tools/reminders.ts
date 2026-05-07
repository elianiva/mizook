import { Option } from "effect";
import { tool } from "ai";
import { z } from "zod";
import type { MizookAgent } from "../agent/mizook-agent";

type ReminderPayload = {
  chatId: number;
  message: string;
};

export function createReminderTools(agent: MizookAgent) {
  return {
    set_reminder: tool({
      description:
        "Set a recurring reminder using a cron schedule. " +
        "Use when the user asks to be reminded at regular intervals. " +
        "Examples: 'every day at 7am' -> cron '0 7 * * *', " +
        "'every Monday at 9am' -> cron '0 9 * * 1', " +
        "'weekdays at 8am' -> cron '0 8 * * 1-5'",
      inputSchema: z.object({
        cron: z
          .string()
          .describe(
            "Cron expression (minute hour day month weekday). " +
              "Examples: '0 7 * * *' = daily at 7am, " +
              "'0 9 * * 1' = Mondays at 9am, " +
              "'0 8 * * 1-5' = weekdays at 8am",
          ),
        message: z.string().describe("The reminder message text"),
      }),
      execute: async ({ cron, message }) => {
        const turn = agent.getTurnState();
        if (Option.isNone(turn) || turn.value.platform !== "telegram")
          return "Reminders are only available in private chat.";

        const schedule = await agent.schedule(cron, "sendReminder", {
          chatId: turn.value.chatId,
          message,
        } satisfies ReminderPayload);

        return `Reminder set. ID: ${schedule.id}. I will remind you: "${message}"`;
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
            const next = new Date(s.time * 1000).toLocaleString();
            const kind =
              s.type === "cron" && "cron" in s
                ? `cron: ${(s as typeof s & { cron: string }).cron}`
                : s.type;
            return `[${s.id.slice(0, 8)}…] ${p.message} — next: ${next} (${kind})`;
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
          ? `Reminder ${scheduleId.slice(0, 8)}… cancelled.`
          : `Reminder not found or already executed.`;
      },
    }),
  };
}
