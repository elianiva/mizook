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
        "CRON EXPRESSIONS MUST BE IN UTC. The user's timezone is UTC+7. " +
        "Convert local times to UTC by subtracting 7 hours from the hour field. " +
        "Example: user says 'every day at 8am' (UTC+7) -> cron '0 1 * * *' (UTC). " +
        "Example: 'every Monday at 9am' -> cron '0 2 * * 1'. " +
        "Example: 'weekdays at midnight' -> cron '0 17 * * 0-4'.",
      inputSchema: z.object({
        cron: z
          .string()
          .describe(
            "Cron expression in UTC (minute hour day month weekday). " +
              "Convert from the user's timezone (UTC+7) by subtracting 7 hours from the hour. " +
              "Examples: '0 1 * * *' = daily at 8am UTC+7, " +
              "'0 2 * * 1' = Mondays at 9am UTC+7",
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
            const next = new Date(s.time * 1000).toLocaleString("en-ID", {
              timeZone: "Asia/Jakarta",
              weekday: "short",
              hour: "2-digit",
              minute: "2-digit",
              day: "numeric",
              month: "short",
            });
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
