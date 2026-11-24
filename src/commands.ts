import { Context, Effect, Layer } from "effect";
import { Agent, type AgentError } from "./agent.ts";
import { COMMANDS } from "./command-list.ts";
import { Settings } from "./config.ts";
import { formatDate } from "./format.ts";
import { Backup } from "./backup.ts";
import {
  Agents,
  AutomationsClient,
  describeProfile,
  GlobalSkills,
  ProfileStore,
  Self,
} from "./host.ts";
import { describeIntent, Intents } from "./intents.ts";
import { describePolicy, Policies } from "./policies.ts";
import { describeAutomation } from "./runner.ts";
import { Skills } from "./skills.ts";
import { isSettingKey, State, type SettingKey } from "./state.ts";
import type { StateError } from "./errors.ts";
import { Usage } from "./usage.ts";

const dollars = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export class Commands extends Context.Service<
  Commands,
  {
    run(place: string, text: string): Effect.Effect<string | undefined, AgentError | StateError>;
  }
>()("mizook/Commands") {
  static readonly layer = Layer.effect(
    Commands,
    Effect.gen(function* () {
      const settings = yield* Settings;
      const state = yield* State;
      const intents = yield* Intents;
      const policies = yield* Policies;
      const skills = yield* Skills;
      const usage = yield* Usage;
      const self = yield* Self;
      const agents = yield* Agents;
      const profileStore = yield* ProfileStore;
      const globalSkills = yield* GlobalSkills;
      const automations = yield* AutomationsClient;
      const backup = yield* Backup;
      const agent = yield* Agent;

      const saveSettingAndReload = (key: SettingKey, value: string | undefined, said: string) =>
        Effect.gen(function* () {
          yield* state.setSetting(key, value);
          yield* agents.reloadAgent(self.doName);
          return said;
        });

      const run = Effect.fn("Commands.run")(function* (place: string, text: string) {
        const match = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
        if (!match) return undefined;
        const arg = (match[2] ?? "").trim();
        const name = match[1] ?? "";
        if (arg === "reset" && isSettingKey(name)) {
          return yield* saveSettingAndReload(name, undefined, `${name} is back to the default.`);
        }
        switch (name) {
          case "stop":
            return (yield* agent.stop(place)) ? "Stopped." : "Nothing is running here.";
          case "cost": {
            const mine = yield* usage.spend;
            const all = yield* agents.spendAll;
            const own = `${self.slug}: ${dollars(mine.last24h)} in 24 h, ${dollars(mine.last7d)} in 7 d, ${dollars(mine.total)} in all.`;
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
              : yield* saveSettingAndReload("model", arg, `Model set to ${arg}.`);
          case "instructions":
            return arg === ""
              ? settings.instructions === ""
                ? `No instructions for ${self.slug}. Set them with /instructions <text>.`
                : `${settings.instructions}\n\n/instructions reset clears it.`
              : yield* saveSettingAndReload("instructions", arg, "Instructions saved.");
          case "timezone":
            return arg === ""
              ? `Time zone: ${settings.timezone}.`
              : yield* saveSettingAndReload("timezone", arg, `Time zone set to ${arg}.`);
          case "budget":
            return arg === ""
              ? `Daily budget: ${settings.budgetDaily === 0 ? "none" : dollars(settings.budgetDaily)}. Set it with /budget <dollars>, 0 for none, or /budget reset.`
              : yield* saveSettingAndReload("budget", arg, `Daily budget set to ${arg}.`);
          case "name":
            if (arg === "")
              return `This place is ${yield* agents.placeLabel(place)}. Rename it with /name <name>.`;
            yield* agents.namePlace(place, arg);
            return `This place is now called ${arg}.`;
          case "agents": {
            const all = yield* agents.all;
            const lines = yield* Effect.forEach(all, (a) =>
              Effect.gen(function* () {
                const where = yield* Effect.forEach(a.bound, (p) => agents.placeLabel(p));
                const roles = [
                  a.isDefault ? "default, answers every unbound place" : "",
                  where.length === 0 ? "" : `bound to ${where.join(", ")}`,
                ].filter((part) => part !== "");
                const role = a.role.trim().split("\n")[0] ?? "";
                return `- /${a.slug} ${a.name}${role === "" ? "" : `: ${role.slice(0, 120)}`}${roles.length === 0 ? "" : ` (${roles.join("; ")})`}`;
              }),
            );
            return lines.join("\n");
          }
          case "agent": {
            if (arg === "") {
              const label = yield* agents.placeLabel(place);
              return `${label} talks to ${self.slug}. Change it with /agent <slug>, or /agent default.`;
            }
            const bound = yield* agents.bind(place, arg === "default" ? undefined : arg);
            if (!bound) {
              const all = yield* agents.all;
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
              const mine = yield* skills.list;
              const shared = yield* globalSkills.list;
              const line = (s: (typeof mine)[number], scope: string) =>
                `- ${s.name}${scope}: ${s.description}${s.pinned ? " (pinned)" : ""}`;
              const all = [
                ...mine.map((s) => line(s, "")),
                ...shared.map((s) => line(s, " (global)")),
              ];
              return all.length === 0 ? "No skills yet." : all.join("\n");
            }
            if (name === "") return "Use /skills, /skills show <name>, or /skills delete <name>.";
            const own = yield* skills.get(name);
            const skill = own ?? (yield* globalSkills.get(name));
            const store = own ? skills : globalSkills;
            if (!skill) return `No skill "${name}".`;
            if (verb === "show") return `# ${skill.name}\n${skill.description}\n\n${skill.body}`;
            if (verb === "delete") {
              return (yield* store.remove(name))
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
              : all.map((intent) => describeIntent(intent, settings.timezone)).join("\n");
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
              const made = yield* policies.add(match, verb);
              return `Policy #${made.id}: ${made.decision} ${made.match}.`;
            }
            const all = yield* policies.list;
            return all.length === 0
              ? "No policies. Use /policies allow|ask|deny <match>."
              : all.map(describePolicy).join("\n");
          }
          case "runs": {
            const id = arg === "" ? undefined : Number(arg);
            if (id !== undefined && (!Number.isInteger(id) || id < 1)) {
              return "Use /runs or /runs <automation id>.";
            }
            const all = yield* automations.runs(10, id);
            return all.length === 0
              ? "No runs yet."
              : all
                  .map((r) => {
                    const detail = r.error ?? r.output;
                    return `#${r.id} automation ${r.automationId} ${r.status} ${formatDate(new Date(r.started), settings.timezone)}${detail === "" ? "" : `: ${detail.slice(0, 160)}`}`;
                  })
                  .join("\n");
          }
          case "automations": {
            const [verb = "", rawId = ""] = arg.split(/\s+/);
            const id = Number(rawId);
            if (verb !== "") {
              if (!Number.isInteger(id) || id < 1) return `Use /automations ${verb} <id>.`;
              switch (verb) {
                case "cancel":
                  return (yield* automations.cancel(id))
                    ? `Deleted #${id}.`
                    : `No automation #${id}.`;
                case "pause":
                  return (yield* automations.pause(id))
                    ? `Paused #${id}.`
                    : `No active automation #${id}.`;
                case "resume":
                  return yield* automations.resume(id).pipe(
                    Effect.map((done) => (done ? `Resumed #${id}.` : `No automation #${id}.`)),
                    Effect.catch((error) =>
                      Effect.succeed(`Could not resume #${id}: ${error.message}.`),
                    ),
                  );
                case "test":
                  return (yield* automations.test(id))
                    ? `Test #${id} started.`
                    : `No automation #${id}.`;
                default:
                  return "Use /automations, or /automations cancel|pause|resume|test <id>.";
              }
            }
            const everyAgent = yield* agents.all;
            const all = yield* automations.list();
            return all.length === 0
              ? "No automations."
              : all
                  .map((a) =>
                    describeAutomation(
                      a,
                      (at) => formatDate(new Date(at), settings.timezone),
                      (agentId) => `/${everyAgent.find((x) => x.id === agentId)?.slug ?? agentId}`,
                    ),
                  )
                  .join("\n");
          }
          case "profile": {
            if (arg === "reset") {
              yield* profileStore.updateProfile("", []);
              return "Profile cleared.";
            }
            const profile = describeProfile(yield* profileStore.profile);
            return profile === ""
              ? "No profile yet. Tell the agent about yourself and every agent will know it."
              : profile;
          }
          case "export":
            return `Your export of ${self.slug} (works for one hour): ${yield* backup.exportLink.pipe(Effect.orDie)}`;
          case "help":
            return COMMANDS.map((c) => `/${c.command}: ${c.description}`).join("\n");
          default:
            return `Unknown command /${match[1]}. Try /help.`;
        }
      });
      return Commands.of({
        run: (place, text) =>
          run(place, text).pipe(
            Effect.catchTag("InvalidInput", (refused) => Effect.succeed(refused.reason)),
          ),
      });
    }),
  );
}
