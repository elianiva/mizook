import { Context, Effect, Layer } from "effect";
import { Agent, type AgentError } from "./agent.ts";
import { COMMANDS } from "./command-list.ts";
import { Settings } from "./config.ts";
import { formatDate } from "./format.ts";
import { Host } from "./host.ts";
import { Schedules } from "./schedules.ts";
import { State } from "./state.ts";
import type { StateError } from "./errors.ts";
import { Usage } from "./usage.ts";

const dollars = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

/** Slash commands: the user's controls over a channel. They never reach the model. */
export class Commands extends Context.Service<
  Commands,
  {
    /** The reply to a command, or `undefined` when the text is not a command at all. Every command gets a reply. */
    run(
      chatId: string,
      threadId: string,
      text: string,
    ): Effect.Effect<string | undefined, AgentError | StateError>;
  }
>()("mizook/Commands") {
  static readonly layer = Layer.effect(
    Commands,
    Effect.gen(function* () {
      const settings = yield* Settings;
      const state = yield* State;
      const schedules = yield* Schedules;
      const usage = yield* Usage;
      const host = yield* Host;
      const agent = yield* Agent;

      /** Save a setting of this channel and rebuild it so the setting takes effect. */
      const set = (key: string, value: string, said: string) =>
        Effect.gen(function* () {
          yield* state.setMeta(`setting:${key}`, value);
          yield* host.reload;
          return said;
        });

      /** Drop a channel's own setting so the environment's value applies again. */
      const reset = (key: string, said: string) =>
        Effect.gen(function* () {
          yield* state.deleteMeta(`setting:${key}`);
          yield* host.reload;
          return said;
        });

      const run = Effect.fn("Commands.run")(function* (
        chatId: string,
        threadId: string,
        text: string,
      ) {
        const match = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
        if (!match) return undefined;
        const arg = (match[2] ?? "").trim();
        const name = match[1] ?? "";
        if (arg === "reset" && ["model", "instructions", "timezone", "budget"].includes(name)) {
          return yield* reset(name, `${name} is back to the default.`);
        }
        switch (name) {
          case "stop":
            return (yield* agent.stop(chatId)) ? "Stopped." : "Nothing is running.";
          case "cost": {
            const mine = yield* usage.spend;
            const all = yield* host.spendAll;
            const own = `This channel: ${dollars(mine.last24h)} in 24 h, ${dollars(mine.last7d)} in 7 d, ${dollars(mine.total)} in all.`;
            if (all.length === 0) return own;
            const sum = (pick: (s: (typeof all)[number]["spend"]) => number) =>
              all.reduce((n, c) => n + pick(c.spend), 0);
            return `${own}\nAll channels: ${dollars(sum((s) => s.last24h))} in 24 h, ${dollars(sum((s) => s.last7d))} in 7 d.\n${all
              .map((c) => `- ${c.name}: ${dollars(c.spend.last24h)} in 24 h`)
              .join("\n")}`;
          }
          case "model":
            return arg === ""
              ? `Model: ${settings.model}. Change it with /model <id>, or /model reset.`
              : yield* set("model", arg, `Model set to ${arg}.`);
          case "instructions":
            return arg === ""
              ? settings.instructions === ""
                ? "No instructions for this channel. Set them with /instructions <text>."
                : `${settings.instructions}\n\n/instructions reset clears it.`
              : yield* set("instructions", arg, "Instructions saved.");
          case "timezone":
            return arg === ""
              ? `Time zone: ${settings.timezone}.`
              : yield* Effect.try({
                  try: () => new Intl.DateTimeFormat("en", { timeZone: arg }),
                  catch: () => "unknown",
                }).pipe(
                  Effect.flatMap(() => set("timezone", arg, `Time zone set to ${arg}.`)),
                  Effect.orElseSucceed(() => `"${arg}" is not an IANA time zone.`),
                );
          case "budget":
            return arg === ""
              ? `Daily budget: ${settings.budgetDaily === 0 ? "none" : dollars(settings.budgetDaily)}. Set it with /budget <dollars>, 0 for none, or /budget reset.`
              : Number.isFinite(Number(arg)) && Number(arg) >= 0
                ? yield* set("budget", arg, `Daily budget set to ${arg}.`)
                : "Give a number of dollars, 0 for none.";
          case "name":
            if (arg === "") return "Give this channel a name: /name finance";
            yield* host.register(threadId, arg);
            return `This channel is now called ${arg}.`;
          case "channels": {
            const all = yield* host.channels;
            return all.length === 0
              ? "No channels yet."
              : all
                  .map(
                    (c) => `- ${c.name} (${formatDate(new Date(c.lastActive), settings.timezone)})`,
                  )
                  .join("\n");
          }
          case "schedules": {
            const all = yield* schedules.list;
            return all.length === 0
              ? "No schedules."
              : all
                  .map(
                    (s) =>
                      `#${s.id} ${s.spec.kind}, next ${formatDate(new Date(s.nextAt), settings.timezone)}: ${s.prompt}`,
                  )
                  .join("\n");
          }
          case "export":
            return `Your export of this channel (works for one hour): ${yield* host.exportNow}`;
          case "help":
            return COMMANDS.map((c) => `/${c.command}: ${c.description}`).join("\n");
          default:
            return `Unknown command /${match[1]}. Try /help.`;
        }
      });
      return Commands.of({ run });
    }),
  );
}
