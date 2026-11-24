import { Effect, Schema } from "effect";
import { Settings } from "./config.ts";
import { ToolError } from "./errors.ts";
import { describeIntent, Intents } from "./intents.ts";
import { defineTool, described } from "./tool.ts";

export const IntentArgs = Schema.Struct({
  action: described(
    Schema.Literals(["create", "list", "cancel"]),
    "create: wait for a future message. list: show what is armed. cancel: stop one.",
  ),
  description: Schema.optionalKey(
    described(
      Schema.String,
      "create: what to do when the trigger appears, as an instruction to yourself.",
    ),
  ),
  triggers: Schema.optionalKey(
    described(
      Schema.Array(Schema.String),
      "create: words or phrases that must all appear in a later message. Use specific terms.",
    ),
  ),
  days: Schema.optionalKey(
    described(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      "create: days until it expires. Default 90.",
    ),
  ),
  max_fires: Schema.optionalKey(
    described(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      "create: how many times it may fire. Default 3.",
    ),
  ),
  cooldown_hours: Schema.optionalKey(
    described(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      "create: hours between fires. Default 24; 0 means no wait.",
    ),
  ),
  id: Schema.optionalKey(
    described(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)), "cancel: the intent number."),
  ),
});

export const intentTools = [
  defineTool({
    name: "intent_manage",
    path: "intents.manage",
    description:
      "Remember what to do when a future message mentions something. A standing intent waits for its trigger words; it is not a timer. Use automations.create for a clock time.",
    args: IntentArgs,
    run: (a) =>
      Effect.gen(function* () {
        const intents = yield* Intents;
        switch (a.action) {
          case "create": {
            const days = a.days ?? 90;
            const made = yield* intents.create(a.description ?? "", a.triggers ?? [], {
              expiresAt: Date.now() + days * 86_400_000,
              cooldownMs: (a.cooldown_hours ?? 24) * 3_600_000,
              maxFires: a.max_fires ?? 3,
            });
            return `Standing intent #${made.id} armed for: ${made.triggers.join(", ")}.`;
          }
          case "list": {
            const all = yield* intents.list;
            const { timezone } = yield* Settings;
            return all.length === 0
              ? "No standing intents."
              : all.map((intent) => describeIntent(intent, timezone)).join("\n");
          }
          case "cancel": {
            if (a.id === undefined) {
              return yield* new ToolError({ reason: "cancel needs an id" });
            }
            return (yield* intents.cancel(a.id))
              ? `Cancelled #${a.id}.`
              : `No armed intent #${a.id}.`;
          }
        }
      }),
  }),
];
