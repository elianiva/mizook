import { tool } from "ai";
import { z } from "zod";
import type { MizookAgent } from "../../core/agent";
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
    case "s":
      return num;
    case "m":
      return num * 60;
    case "h":
      return num * 3600;
    case "d":
      return num * 86400;
    default:
      return null;
  }
}

function formatDuration(totalSeconds: number): string {
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function describeCron(cronExpr: string, tz: string): string {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return cronExpr;

  const [min, hour, dom, , dow] = parts;

  const hourNum = parseInt(hour, 10);
  const minNum = parseInt(min, 10);
  const d = new Date(Date.UTC(2024, 0, 1, hourNum, minNum));
  const timeStr = new Intl.DateTimeFormat("en", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).format(d);

  // Day-of-month
  if (dom !== "*") {
    const dayNum = parseInt(dom, 10);
    const v = dayNum % 100;
    const suffix = v >= 11 && v <= 13 ? "th" : ["th", "st", "nd", "rd"][v % 10] || "th";
    return `${dayNum}${suffix} of every month at ${timeStr}`;
  }

  // Day-of-week
  if (dow !== "*") {
    if (dow.includes("-")) {
      const [start, end] = dow.split("-").map(Number);
      if (start === 1 && end === 5) return `Every weekday at ${timeStr}`;
      if (start === 0 && end === 4) return `Every Sun–Thu at ${timeStr}`;
      return `Every ${DOW_NAMES[start]}–${DOW_NAMES[end]} at ${timeStr}`;
    }
    return `Every ${DOW_NAMES[parseInt(dow, 10)]} at ${timeStr}`;
  }

  if (hour !== "*") return `Every day at ${timeStr}`;
  if (min !== "*") return `Every hour at :${String(minNum).padStart(2, "0")}`;
  return cronExpr;
}

function formatFireTime(timeMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timeMs));
}

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
        duration: z
          .string()
          .optional()
          .describe(
            "For ONE-TIME reminders: how long from now (e.g. '30m', '2h', '1d'). Omit for recurring.",
          ),
        cron: z
          .string()
          .optional()
          .describe(
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
          const desc = describeCron(cron, tz);
          return `Recurring reminder set. ID: ${schedule.id}. "${message}" — ${desc}`;
        }

        if (!duration) {
          return "Either duration (for one-time) or cron (for recurring) is required.";
        }

        const seconds = parseDurationToSeconds(duration);
        if (seconds === null) {
          return `Could not parse duration "${duration}". Use e.g. '30m', '2h', '1d'.`;
        }

        const schedule = await agent.schedule(seconds, "sendReminder", payload);
        const humanDuration = formatDuration(seconds);
        const fireAt = formatFireTime(Date.now() + seconds * 1000, tz);
        return `One-time reminder set. ID: ${schedule.id}. "${message}" in ${humanDuration} (at ${fireAt})`;
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
            const next = formatFireTime(s.time * 1000, tz);

            if (s.type === "cron" && "cron" in s) {
              const desc = describeCron((s as typeof s & { cron: string }).cron, tz);
              return `ID: ${s.id} | "${p.message}" — ${desc} · next: ${next}`;
            }

            const secsUntil = Math.max(0, Math.round(s.time - Date.now()));
            const remaining = secsUntil > 0 ? ` · in ${formatDuration(secsUntil)}` : "";
            return `ID: ${s.id} | "${p.message}" — one-time · ${next}${remaining}`;
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

    delete_all_reminders: tool({
      description: "Cancel all active reminders at once",
      inputSchema: z.object({}),
      execute: async () => {
        const all = await agent.listSchedules();
        const reminders = all.filter((s) => s.callback === "sendReminder");
        if (reminders.length === 0) return "No active reminders.";

        let count = 0;
        for (const s of reminders) {
          const ok = await agent.cancelSchedule(s.id);
          if (ok) count++;
        }
        return count === reminders.length
          ? `All ${count} reminder${count === 1 ? "" : "s"} cancelled.`
          : `Cancelled ${count} of ${reminders.length} reminders.`;
      },
    }),
  };
}
