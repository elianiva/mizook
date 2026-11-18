/** The slash commands, once: the bot menu in Telegram, `/help`, and the handler all read this. */
export const COMMANDS = [
  { command: "stop", description: "Stop the running turn" },
  { command: "cost", description: "What the model calls cost" },
  { command: "model", description: "Show or set this channel's model" },
  {
    command: "instructions",
    description: "Show, set or reset (/instructions reset) the instructions",
  },
  { command: "timezone", description: "Show or set the time zone" },
  { command: "budget", description: "Show or set the daily budget" },
  { command: "name", description: "Name this channel" },
  { command: "channels", description: "List the channels" },
  { command: "profile", description: "Show or reset the profile every channel shares" },
  { command: "schedules", description: "List this channel's schedules" },
  { command: "export", description: "Export this channel as a file" },
  { command: "help", description: "List the commands" },
] as const;
