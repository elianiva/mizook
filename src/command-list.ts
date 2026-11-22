/** The slash commands, once: the bot menu in Telegram, `/help`, and the handler all read this. */
export const COMMANDS = [
  { command: "stop", description: "Stop the running turn" },
  { command: "cost", description: "What the model calls cost" },
  { command: "model", description: "Show or set this agent's model" },
  {
    command: "instructions",
    description: "Show, set or reset (/instructions reset) the instructions",
  },
  { command: "timezone", description: "Show or set the time zone" },
  { command: "budget", description: "Show or set the daily budget" },
  { command: "agent", description: "Show or change which agent answers here" },
  { command: "agents", description: "List the agents and where they answer" },
  { command: "name", description: "Name this place" },
  { command: "profile", description: "Show or reset the profile every agent shares" },
  { command: "skills", description: "List, show or delete the agent's skills" },
  { command: "intents", description: "List or cancel standing intents" },
  { command: "policies", description: "List, add or remove approval rules" },
  { command: "schedules", description: "List this agent's schedules" },
  { command: "runs", description: "Show the last runs of a schedule" },
  { command: "export", description: "Export this agent as a file" },
  { command: "help", description: "List the commands" },
] as const;
