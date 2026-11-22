import { Context, Effect, Layer } from "effect";
import { Agent, type AgentError } from "./agent.ts";
import { COMMANDS } from "./command-list.ts";
import { Settings } from "./config.ts";
import { formatDate } from "./format.ts";
import { Host } from "./host.ts";
import { Intents } from "./intents.ts";
import { Policies } from "./policies.ts";
import { Runs } from "./runs.ts";
import { Schedules } from "./schedules.ts";
import { Skills } from "./skills.ts";
import { State } from "./state.ts";
import type { StateError } from "./errors.ts";
import { Usage } from "./usage.ts";

const dollars = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

/** Slash commands: the user's controls over an agent and the place they type in. They never reach the model. */
export class Commands extends Context.Service<
  Commands,
  {
    /**
     * The reply to a command typed in `place`, or `undefined` when the text is not a command at
     * all. Every command gets a reply.
     */
    run(place: string, text: string): Effect.Effect<string | undefined, AgentError | StateError>;
  }
>()("mizook/Commands") {
  static readonly layer = Layer.effect(
    Commands,
    Effect.gen(function* () {
      const settings = yield* Settings;
      const state = yield* State;
      const schedules = yield* Schedules;
      const intents = yield* Intents;
      const policies = yield* Policies;
      const runs = yield* Runs;
      const skills = yield* Skills;
      const usage = yield* Usage;
      const host = yield* Host;
      const agent = yield* Agent;

      /** Save a setting of this agent and rebuild it so the setting takes effect. */
      const set = (key: string, value: string, said: string) =>
        Effect.gen(function* () {
          yield* state.setMeta(`setting:${key}`, value);
          yield* host.reload;
          return said;
        });

      /** Drop an agent's own setting so the environment's value applies again. */
      const reset = (key: string, said: string) =>
        Effect.gen(function* () {
          yield* state.deleteMeta(`setting:${key}`);
          yield* host.reload;
          return said;
        });

      const run = Effect.fn("Commands.run")(function* (place: string, text: string) {
        const match = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
        if (!match) return undefined;
        const arg = (match[2] ?? "").trim();
        const name = match[1] ?? "";
        if (arg === "reset" && ["model", "instructions", "timezone", "budget"].includes(name)) {
          return yield* reset(name, `${name} is back to the default.`);
        }
        switch (name) {
          case "stop":
            return (yield* agent.stop(place)) ? "Stopped." : "Nothing is running here.";
          case "cost": {
            const mine = yield* usage.spend;
            const all = yield* host.spendAll;
            const own = `${host.self.slug}: ${dollars(mine.last24h)} in 24 h, ${dollars(mine.last7d)} in 7 d, ${dollars(mine.total)} in all.`;
            if (all.length === 0) return own;
            const sum = (pick: (s: (typeof all)[number]["spend"]) => number) =>
              all.reduce((n, c) => n + pick(c.spend), 0);
            return `${own}\nAll agents: ${dollars(sum((s) => s.last24h))} in 24 h, ${dollars(sum((s) => s.last7d))} in 7 d.\n${all
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
                ? `No instructions for ${host.self.slug}. Set them with /instructions <text>.`
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
            if (arg === "")
              return `This place is ${yield* host.placeLabel(place)}. Rename it with /name <name>.`;
            yield* host.namePlace(place, arg);
            return `This place is now called ${arg}.`;
          case "agents": {
            const all = yield* host.agents;
            const lines = yield* Effect.forEach(all, (a) =>
              Effect.gen(function* () {
                const where = yield* Effect.forEach(a.bound, (p) => host.placeLabel(p));
                const roles = [
                  a.isDefault ? "default, answers every unbound place" : "",
                  where.length === 0 ? "" : `bound to ${where.join(", ")}`,
                ].filter((part) => part !== "");
                return `- /${a.slug} ${a.name}${roles.length === 0 ? "" : ` (${roles.join("; ")})`}`;
              }),
            );
            return lines.join("\n");
          }
          case "agent": {
            if (arg === "") {
              const label = yield* host.placeLabel(place);
              return `${label} talks to ${host.self.slug}. Change it with /agent <slug>, or /agent default.`;
            }
            const bound = yield* host.bind(place, arg === "default" ? undefined : arg);
            if (!bound) {
              const all = yield* host.agents;
              return `No agent "${arg}". Agents: ${all.map((a) => a.slug).join(", ")}.`;
            }
            return arg === "default"
              ? `This place talks to the default agent, ${bound.slug}, again.`
              : `This place now talks to ${bound.slug}.`;
          }
          case "skills": {
            const [verb = "", ...rest] = arg.split(/\s+/);
            const name = rest.join(" ").trim();
            if (verb === "") {
              const all = yield* skills.list;
              return all.length === 0
                ? "No skills yet."
                : all
                    .map((s) => `- ${s.name}: ${s.description}${s.pinned ? " (pinned)" : ""}`)
                    .join("\n");
            }
            if (name === "") return "Use /skills, /skills show <name>, or /skills delete <name>.";
            const skill = yield* skills.get(name);
            if (!skill) return `No skill "${name}".`;
            if (verb === "show") return `# ${skill.name}\n${skill.description}\n\n${skill.body}`;
            if (verb === "delete") {
              if (skill.pinned)
                return `"${name}" is pinned by a schedule; cancel the schedule first.`;
              return (yield* skills.remove(name))
                ? `Deleted skill "${name}".`
                : `No skill "${name}".`;
            }
            return "Use /skills, /skills show <name>, or /skills delete <name>.";
          }
          case "intents": {
            const [verb = "", rawId = ""] = arg.split(/\s+/);
            if (verb === "cancel") {
              const id = Number(rawId);
              if (!Number.isInteger(id) || id < 1) return "Use /intents cancel <id>.";
              return (yield* intents.cancel(id))
                ? `Cancelled intent #${id}.`
                : `No armed intent #${id}.`;
            }
            const all = yield* intents.list;
            return all.length === 0
              ? "No standing intents."
              : all
                  .map(
                    (intent) =>
                      `#${intent.id} ${intent.state} [${intent.triggers.join(", ")}] ${intent.description} (fires ${intent.fireCount}/${intent.maxFires}, expires ${formatDate(new Date(intent.expires), settings.timezone)})`,
                  )
                  .join("\n");
          }
          case "policies": {
            const [verb = "", ...rest] = arg.split(/\s+/);
            const match = rest.join(" ").trim();
            if (verb === "remove") {
              const id = Number(match);
              if (!Number.isInteger(id) || id < 1) return "Use /policies remove <id>.";
              return (yield* policies.remove(id)) ? `Removed policy #${id}.` : `No policy #${id}.`;
            }
            if (verb === "allow" || verb === "ask" || verb === "deny") {
              if (match === "") return `Use /policies ${verb} <match>.`;
              const made = yield* policies.add(match.toLowerCase(), verb);
              return `Policy #${made.id}: ${made.decision} ${made.match}.`;
            }
            const all = yield* policies.list;
            return all.length === 0
              ? "No policies. Use /policies allow|ask|deny <match>."
              : all.map((policy) => `#${policy.id} ${policy.decision} ${policy.match}`).join("\n");
          }
          case "runs": {
            const id = arg === "" ? undefined : Number(arg);
            if (id !== undefined && (!Number.isInteger(id) || id < 1)) {
              return "Use /runs or /runs <schedule id>.";
            }
            const all = yield* runs.list({
              limit: 10,
              ...(id === undefined ? {} : { scheduleId: id }),
            });
            return all.length === 0
              ? "No runs yet."
              : all
                  .map((r) => {
                    const detail = r.error ?? r.output;
                    return `#${r.id} schedule ${r.scheduleId} ${r.status} ${formatDate(new Date(r.started), settings.timezone)}${detail === "" ? "" : `: ${detail.slice(0, 160)}`}`;
                  })
                  .join("\n");
          }
          case "schedules": {
            const all = yield* schedules.all;
            return all.length === 0
              ? "No schedules."
              : all
                  .map(
                    (s) =>
                      `#${s.id} ${s.spec.kind}${s.skill ? ` [skill ${s.skill}]` : ""} ${s.active ? `next ${formatDate(new Date(s.nextAt), settings.timezone)}` : "inactive"}: ${s.prompt}`,
                  )
                  .join("\n");
          }
          case "profile": {
            if (arg === "reset") {
              yield* host.updateProfile("", []);
              return "Profile cleared.";
            }
            const profile = yield* host.profile;
            if (profile.about.trim() === "" && profile.rules.length === 0) {
              return "No profile yet. Tell the agent about yourself and every agent will know it.";
            }
            return [
              profile.about.trim() === "" ? "" : `About: ${profile.about.trim()}`,
              profile.rules.length === 0
                ? ""
                : `Rules:\n${profile.rules.map((rule) => `- ${rule}`).join("\n")}`,
            ]
              .filter((part) => part !== "")
              .join("\n\n");
          }
          case "export":
            return `Your export of ${host.self.slug} (works for one hour): ${yield* host.exportNow}`;
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
