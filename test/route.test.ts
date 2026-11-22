import { Arbitrary, Effect, Exit, Schema } from "effect";
import { expect } from "vite-plus/test";
import { routeOf } from "../src/route.ts";
import { property } from "./property.ts";

const route = (update: unknown) => routeOf(JSON.stringify(update));

const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));

const maybe = <A>(value: Arbitrary.Arbitrary<A>) =>
  Arbitrary.all({ present: Arbitrary.schema(Schema.Boolean), value }).pipe(
    Arbitrary.map(({ present, value }) => (present ? value : undefined)),
  );

const message = Arbitrary.all({
  chat: maybe(int(-1_000_000_000_000, 1_000_000_000_000)),
  thread: maybe(int(1, 1_000_000)),
  topicFlag: Arbitrary.schema(Schema.Literals(["true", "false", "absent"])),
});

type Message = typeof message extends Arbitrary.Arbitrary<infer A> ? A : never;

const toTelegram = (m: Message) => ({
  ...(m.chat === undefined ? {} : { chat: { id: m.chat } }),
  ...(m.thread === undefined ? {} : { message_thread_id: m.thread }),
  ...(m.topicFlag === "absent" ? {} : { is_topic_message: m.topicFlag === "true" }),
});

const CONTAINERS = [
  "message",
  "edited_message",
  "channel_post",
  "callback_query",
  "message_reaction",
] as const;

property(
  "the place is telegram:<chat>:<topic> for a topic message, telegram:<chat> otherwise, and telegram:main with no chat, taken from the first container present",
  Arbitrary.all({
    present: Arbitrary.array(Arbitrary.schema(Schema.Literals(CONTAINERS)), { maxLength: 5 }),
    messages: Arbitrary.array(message, { minLength: 5, maxLength: 5 }),
  }),
  ({ present, messages }) =>
    Effect.gen(function* () {
      const update: Record<string, unknown> = {};
      for (const [i, container] of CONTAINERS.entries()) {
        if (!present.includes(container)) continue;
        const body = toTelegram(messages[i]!);
        update[container] = container === "callback_query" ? { message: body } : body;
      }
      const first = CONTAINERS.findIndex((c) => present.includes(c));
      const chosen = first === -1 ? undefined : messages[first]!;
      const expected =
        chosen?.chat === undefined
          ? "telegram:main"
          : chosen.topicFlag === "true" && chosen.thread !== undefined
            ? `telegram:${chosen.chat}:${chosen.thread}`
            : `telegram:${chosen.chat}`;
      expect((yield* route(update)).place).toBe(expected);
    }),
);

const commandName = Arbitrary.schema(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_]{1,20}$/)));

property(
  "a message starting with /name, an optional @bot, then a space or the end names the command in lowercase",
  Arbitrary.all({
    name: commandName,
    bot: maybe(Arbitrary.schema(Schema.String.check(Schema.isPattern(/^\w{1,12}$/)))),
    after: Arbitrary.schema(Schema.Literals(["", " rest of it", "\nnext line", "-dash", ".dot"])),
    lead: Arbitrary.schema(Schema.Literals(["", " ", "x", "hello "])),
    field: Arbitrary.schema(Schema.Literals(["text", "caption", "edited"])),
  }),
  ({ name, bot, after, lead, field }) =>
    Effect.gen(function* () {
      const said = `${lead}/${name}${bot === undefined ? "" : `@${bot}`}${after}`;
      const body = { chat: { id: -1001 }, [field === "edited" ? "text" : field]: said };
      const update = field === "edited" ? { edited_message: body } : { message: body };
      const startsCleanly = lead === "" && (after === "" || /^\s/.test(after));
      const expected = field !== "edited" && startsCleanly ? name.toLowerCase() : undefined;
      expect((yield* route(update)).command).toBe(expected);
    }),
);

const button = Arbitrary.all({
  verb: Arbitrary.schema(Schema.Literals(["approve", "always", "deny"])),
  agent: Arbitrary.schema(Schema.String.check(Schema.isPattern(/^[a-z0-9]{1,16}$/))),
  id: int(0, 10_000_000),
  wrapped: Arbitrary.schema(Schema.Boolean),
});

property(
  "an approval button names its agent, raw or wrapped by the Chat SDK",
  button,
  ({ verb, agent, id, wrapped }) =>
    Effect.gen(function* () {
      const action = `${verb}:${agent}:${id}`;
      const data = wrapped ? `chat:${JSON.stringify({ a: action })}` : action;
      expect((yield* route({ callback_query: { data } })).agentId).toBe(agent);
    }),
);

property(
  "a button with no agent, another verb, or a broken Chat SDK wrapper names no agent",
  Arbitrary.all({
    button,
    broken: Arbitrary.schema(
      Schema.Literals(["no agent", "other verb", "bad wrapper", "uppercase"]),
    ),
  }),
  ({ button: { verb, agent, id, wrapped }, broken }) =>
    Effect.gen(function* () {
      const action =
        broken === "no agent"
          ? `${verb}:${id}`
          : broken === "other verb"
            ? `cancel:${agent}:${id}`
            : broken === "uppercase"
              ? `${verb}:${agent.toUpperCase()}X:${id}`
              : `${verb}:${agent}:${id}`;
      const data =
        broken === "bad wrapper"
          ? `chat:{${action}`
          : wrapped
            ? `chat:${JSON.stringify({ a: action })}`
            : action;
      expect((yield* route({ callback_query: { data } })).agentId).toBeUndefined();
    }),
);

property(
  "a body that is not JSON is a failure, not a throw",
  Arbitrary.schema(Schema.String).pipe(
    Arbitrary.map((text) => `{${text}`),
    Arbitrary.filter((body) => {
      try {
        JSON.parse(body);
        return false;
      } catch {
        return true;
      }
    }),
  ),
  (body) =>
    Effect.gen(function* () {
      expect(Exit.isFailure(yield* Effect.exit(routeOf(body)))).toBe(true);
    }),
);
