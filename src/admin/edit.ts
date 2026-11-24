import { Effect, Option, Schema } from "effect";
import type { InvalidInput, StateError } from "../errors.ts";
import { Host } from "../host.ts";
import { Intents } from "../intents.ts";
import { Policies } from "../policies.ts";
import { pinnedRefusal, Skills } from "../skills.ts";

export type EditOutcome =
  | { readonly ok: true; readonly said: string }
  | { readonly ok: false; readonly error: string };

const refused = (error: string): EditOutcome => ({ ok: false, error });

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

const said = (text: string): EditOutcome => ({ ok: true, said: text });

const profile = (input: ProfileInput) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const saved = yield* host.updateProfile(input.about ?? "", input.rules ?? []);
    return said(
      `Profile saved with ${saved.rules.length} rule${saved.rules.length === 1 ? "" : "s"}.`,
    );
  });

const skill = (input: SkillInput) =>
  Effect.gen(function* () {
    const skills = yield* Skills;
    const name = (input.name ?? "").trim();
    if (name === "") return refused("Give the skill a name.");
    if (input.action === "delete") {
      return (yield* skills.remove(name))
        ? said(`Deleted skill "${name}".`)
        : refused(`No skill "${name}".`);
    }
    const existing = yield* skills.get(name);
    if (existing?.pinned === true && input.pinned === false) return refused(pinnedRefusal(name));
    yield* skills.save(name, input.description ?? "", input.body ?? "");
    if (input.pinned !== undefined) yield* skills.setPinned(name, input.pinned);
    return said(`Saved skill "${name}".`);
  });

const wholeId = (id: number | undefined): id is number =>
  id !== undefined && Number.isInteger(id) && id >= 1;

const intent = (input: IntentInput) =>
  Effect.gen(function* () {
    const intents = yield* Intents;
    if (input.action === "cancel") {
      if (!wholeId(input.id)) return refused("Choose an intent to cancel.");
      return (yield* intents.cancel(input.id))
        ? said(`Cancelled intent #${input.id}.`)
        : refused(`No armed intent #${input.id}.`);
    }
    const cooldownHours = input.cooldownHours ?? Number.NaN;
    const changes = {
      description: input.description ?? "",
      triggers: input.triggers ?? [],
      expires: input.expires ?? Number.NaN,
      cooldown: cooldownHours * 3_600_000,
      maxFires: input.maxFires ?? Number.NaN,
    };
    if (input.id === undefined) {
      const made = yield* intents.create(changes.description, changes.triggers, {
        expiresAt: changes.expires,
        cooldownMs: changes.cooldown,
        maxFires: changes.maxFires,
      });
      return said(`Standing intent #${made.id} armed.`);
    }
    if (!wholeId(input.id)) return refused("Choose an intent to save.");
    return (yield* intents.update(input.id, changes))
      ? said(`Saved intent #${input.id}.`)
      : refused(`No intent #${input.id}.`);
  });

const policy = (input: PolicyInput) =>
  Effect.gen(function* () {
    const policies = yield* Policies;
    if (input.action === "remove") {
      if (!wholeId(input.id)) return refused("Choose a policy to remove.");
      return (yield* policies.remove(input.id))
        ? said(`Removed policy #${input.id}.`)
        : refused(`No policy #${input.id}.`);
    }
    const match = input.match ?? "";
    const decision = input.decision ?? "ask";
    if (input.id === undefined) {
      const made = yield* policies.add(match, decision);
      return said(`Policy #${made.id}: ${made.decision} ${made.match}.`);
    }
    if (!wholeId(input.id)) return refused("Choose a policy to save.");
    return (yield* policies.update(input.id, match, decision))
      ? said(`Saved policy #${input.id}.`)
      : refused(`No policy #${input.id}.`);
  });

const parse =
  <S extends Schema.Decoder<unknown>, R>(
    schema: S,
    apply: (input: S["Type"]) => Effect.Effect<EditOutcome, StateError | InvalidInput, R>,
  ) =>
  (input: unknown): Effect.Effect<EditOutcome, StateError | InvalidInput, R> => {
    const parsed = Schema.decodeUnknownOption(schema)(input);
    return Option.isNone(parsed) ? Effect.succeed(refused("Bad request.")) : apply(parsed.value);
  };

const EDITS: Record<
  string,
  (
    input: unknown,
  ) => Effect.Effect<EditOutcome, StateError | InvalidInput, Host | Skills | Intents | Policies>
> = {
  profile: parse(ProfileInput, profile),
  skills: parse(SkillInput, skill),
  intents: parse(IntentInput, intent),
  policies: parse(PolicyInput, policy),
};

/** Applies one dashboard edit. A refused one says why, in words for the dashboard to show. */
export const edit = (
  kind: string,
  input: unknown,
): Effect.Effect<EditOutcome, StateError, Host | Skills | Intents | Policies> =>
  Object.hasOwn(EDITS, kind)
    ? EDITS[kind]!(input).pipe(
        Effect.catchTag("InvalidInput", (error) => Effect.succeed(refused(error.reason))),
      )
    : Effect.succeed(refused("Unknown thing to edit."));
