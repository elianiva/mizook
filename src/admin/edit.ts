import { Effect, Option, Schema } from "effect";
import type { StateError } from "../errors.ts";
import { Host } from "../host.ts";
import {
  Intents,
  MAX_INTENT_DESCRIPTION,
  MAX_INTENT_TRIGGERS,
  MAX_TRIGGER_LENGTH,
} from "../intents.ts";
import { Policies } from "../policies.ts";
import { MAX_SKILL_BODY, MAX_SKILL_DESCRIPTION, SKILL_NAME, Skills } from "../skills.ts";

/** A write the dashboard asked for: either the reply to show, or the reason it did not happen. */
export type EditOutcome =
  | { readonly ok: true; readonly said: string }
  | { readonly ok: false; readonly error: string };

const bad = (error: string): EditOutcome => ({ ok: false, error });

const ProfileInput = Schema.Struct({
  about: Schema.optionalKey(Schema.String),
  rules: Schema.optionalKey(Schema.Array(Schema.String)),
});

const SkillInput = Schema.Struct({
  action: Schema.optionalKey(Schema.Literals(["save", "delete"])),
  name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.String),
  pinned: Schema.optionalKey(Schema.Boolean),
});

const IntentInput = Schema.Struct({
  action: Schema.optionalKey(Schema.Literals(["save", "cancel"])),
  id: Schema.optionalKey(Schema.Finite),
  description: Schema.optionalKey(Schema.String),
  triggers: Schema.optionalKey(Schema.Array(Schema.String)),
  expires: Schema.optionalKey(Schema.Finite),
  maxFires: Schema.optionalKey(Schema.Finite),
  cooldownHours: Schema.optionalKey(Schema.Finite),
});

const PolicyInput = Schema.Struct({
  action: Schema.optionalKey(Schema.Literals(["save", "remove"])),
  id: Schema.optionalKey(Schema.Finite),
  match: Schema.optionalKey(Schema.String),
  decision: Schema.optionalKey(Schema.Literals(["allow", "ask", "deny"])),
});

type ProfileInput = typeof ProfileInput.Type;
type SkillInput = typeof SkillInput.Type;
type IntentInput = typeof IntentInput.Type;
type PolicyInput = typeof PolicyInput.Type;

const clean = (values: ReadonlyArray<string> | undefined): string[] =>
  (values ?? []).map((value) => value.trim()).filter((value) => value !== "");

const profile = (input: ProfileInput) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const about = (input.about ?? "").trim();
    const rules = clean(input.rules);
    if (about.length > 4_000) return bad("Keep the profile under 4,000 characters.");
    if (rules.length > 20) return bad("Keep the rules to 20 or fewer.");
    if (rules.some((rule) => rule.length > 500)) return bad("Keep each rule under 500 characters.");
    const saved = yield* host.updateProfile(about, rules);
    return {
      ok: true as const,
      said: `Profile saved with ${saved.rules.length} rule${saved.rules.length === 1 ? "" : "s"}.`,
    };
  });

const skill = (input: SkillInput) =>
  Effect.gen(function* () {
    const skills = yield* Skills;
    const action = input.action ?? "save";
    const name = (input.name ?? "").trim();
    if (name === "") return bad("Give the skill a name.");
    if (action === "delete") {
      const found = yield* skills.get(name);
      if (!found) return bad(`No skill "${name}".`);
      if (found.pinned)
        return bad(`"${name}" is pinned by an automation; cancel the automation first.`);
      return (yield* skills.remove(name))
        ? { ok: true as const, said: `Deleted skill "${name}".` }
        : bad(`No skill "${name}".`);
    }

    const description = (input.description ?? "").trim();
    const body = (input.body ?? "").trim();
    if (!SKILL_NAME.test(name)) {
      return bad("Use lowercase letters, digits and dashes for the name, up to 64 characters.");
    }
    const existing = yield* skills.get(name);
    if (existing?.pinned === true && input.pinned === false) {
      return bad(`"${name}" is pinned by an automation; cancel the automation first.`);
    }
    if (description === "") return bad("Describe when to use the skill.");
    if (description.length > MAX_SKILL_DESCRIPTION) {
      return bad(`Keep the description under ${MAX_SKILL_DESCRIPTION} characters.`);
    }
    if (body === "") return bad("Write the skill's steps.");
    if (body.length > MAX_SKILL_BODY) {
      return bad(`Keep the body under ${MAX_SKILL_BODY} characters.`);
    }
    yield* skills.save(name, description, body);
    if (input.pinned !== undefined) yield* skills.setPinned(name, input.pinned);
    return { ok: true as const, said: `Saved skill "${name}".` };
  });

const intent = (input: IntentInput) =>
  Effect.gen(function* () {
    const intents = yield* Intents;
    const action = input.action ?? "save";

    if (action === "cancel") {
      const id = input.id;
      if (id === undefined || !Number.isInteger(id) || id < 1)
        return bad("Choose an intent to cancel.");
      return (yield* intents.cancel(id))
        ? { ok: true as const, said: `Cancelled intent #${id}.` }
        : bad(`No armed intent #${id}.`);
    }

    const description = (input.description ?? "").trim();
    const triggers = clean(input.triggers);
    if (description === "") return bad("Say what the intent should do.");
    if (description.length > MAX_INTENT_DESCRIPTION) {
      return bad(`Keep the description under ${MAX_INTENT_DESCRIPTION} characters.`);
    }
    if (triggers.length === 0) return bad("Add at least one trigger.");
    if (triggers.length > MAX_INTENT_TRIGGERS) {
      return bad(`Keep triggers to ${MAX_INTENT_TRIGGERS} or fewer.`);
    }
    if (triggers.some((trigger) => trigger.length > MAX_TRIGGER_LENGTH)) {
      return bad(`Keep each trigger under ${MAX_TRIGGER_LENGTH} characters.`);
    }
    const expires = input.expires;
    if (expires === undefined || !Number.isInteger(expires) || expires <= Date.now()) {
      return bad("Choose an expiry date in the future.");
    }
    const maxFires = input.maxFires;
    if (maxFires === undefined || !Number.isInteger(maxFires) || maxFires < 1 || maxFires > 1_000) {
      return bad("Let the intent fire between 1 and 1,000 times.");
    }
    const cooldownHours = input.cooldownHours;
    if (
      cooldownHours === undefined ||
      !Number.isFinite(cooldownHours) ||
      cooldownHours < 0 ||
      cooldownHours > 8_760
    ) {
      return bad("Use a cooldown between 0 and 8,760 hours.");
    }
    const changes = {
      description,
      triggers,
      expires,
      cooldown: Math.round(cooldownHours * 3_600_000),
      maxFires,
    };

    if (input.id === undefined) {
      const made = yield* intents.create(description, triggers, {
        expiresAt: expires,
        cooldownMs: changes.cooldown,
        maxFires,
      });
      return { ok: true as const, said: `Standing intent #${made.id} armed.` };
    }
    const id = input.id;
    if (!Number.isInteger(id) || id < 1) return bad("Choose an intent to save.");
    const saved = yield* intents.update(id, changes);
    return saved ? { ok: true as const, said: `Saved intent #${id}.` } : bad(`No intent #${id}.`);
  });

const policy = (input: PolicyInput) =>
  Effect.gen(function* () {
    const policies = yield* Policies;
    const action = input.action ?? "save";

    if (action === "remove") {
      const id = input.id;
      if (id === undefined || !Number.isInteger(id) || id < 1)
        return bad("Choose a policy to remove.");
      return (yield* policies.remove(id))
        ? { ok: true as const, said: `Removed policy #${id}.` }
        : bad(`No policy #${id}.`);
    }

    const match = (input.match ?? "").trim().toLowerCase();
    const decision = input.decision ?? "ask";
    if (match === "") return bad("Give the policy something to match.");
    if (match.length > 200) return bad("Keep the match under 200 characters.");
    if (input.id === undefined) {
      const made = yield* policies.add(match, decision);
      return { ok: true as const, said: `Policy #${made.id}: ${made.decision} ${made.match}.` };
    }
    const id = input.id;
    if (!Number.isInteger(id) || id < 1) return bad("Choose a policy to save.");
    const all = yield* policies.list;
    if (!all.some((item) => item.id === id)) return bad(`No policy #${id}.`);
    if (all.some((item) => item.id !== id && item.match === match && item.decision === decision)) {
      return bad("That rule already exists.");
    }
    const saved = yield* policies.update(id, match, decision);
    return saved ? { ok: true as const, said: `Saved policy #${id}.` } : bad(`No policy #${id}.`);
  });

/** Apply a dashboard edit through the same services the chat uses. */
export const edit = (
  kind: string,
  input: unknown,
): Effect.Effect<EditOutcome, StateError, Host | Skills | Intents | Policies> => {
  switch (kind) {
    case "profile": {
      const parsed = Schema.decodeUnknownOption(ProfileInput)(input);
      return Option.isNone(parsed) ? Effect.succeed(bad("Bad request.")) : profile(parsed.value);
    }
    case "skills": {
      const parsed = Schema.decodeUnknownOption(SkillInput)(input);
      return Option.isNone(parsed) ? Effect.succeed(bad("Bad request.")) : skill(parsed.value);
    }
    case "intents": {
      const parsed = Schema.decodeUnknownOption(IntentInput)(input);
      return Option.isNone(parsed) ? Effect.succeed(bad("Bad request.")) : intent(parsed.value);
    }
    case "policies": {
      const parsed = Schema.decodeUnknownOption(PolicyInput)(input);
      return Option.isNone(parsed) ? Effect.succeed(bad("Bad request.")) : policy(parsed.value);
    }
    default:
      return Effect.succeed(bad("Unknown thing to edit."));
  }
};
