import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { hookToken, hookTokenValid } from "../src/hooks.ts";
import { HookSecretMissing } from "../src/errors.ts";
import { property } from "./property.ts";

const wellFormedOf = (schema: Schema.String) =>
  Arbitrary.schema(schema).pipe(Arbitrary.filter((text) => !/\p{Cs}/u.test(text)));

const wellFormed = wellFormedOf(Schema.String);

const secretText = wellFormedOf(Schema.String.check(Schema.isMinLength(1))).pipe(
  Arbitrary.filter((secret) => !secret.includes("\u0000")),
);

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

property(
  "a webhook token is 43 base64url characters and is valid for its own secret and channel",
  Arbitrary.all({ secret: secretText, channel: wellFormed }),
  ({ secret, channel }) =>
    Effect.promise(async () => {
      const token = await Effect.runPromise(hookToken(secret, channel));
      expect(token).toHaveLength(43);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await Effect.runPromise(hookToken(secret, channel))).toBe(token);
      expect(await Effect.runPromise(hookTokenValid(secret, channel, token))).toBe(true);
    }),
);

const twoDifferent = (text: Arbitrary.Arbitrary<string>) =>
  Arbitrary.all({
    base: text,
    extra: secretText,
    longerFirst: Arbitrary.schema(Schema.Boolean),
    unrelated: text,
  }).pipe(
    Arbitrary.map(({ base, extra, longerFirst, unrelated }): [string, string] =>
      unrelated !== base && unrelated !== ""
        ? [base, unrelated]
        : longerFirst
          ? [base + extra, base]
          : [base, base + extra],
    ),
  );

property(
  "a token made for another channel is refused",
  Arbitrary.all({ secret: secretText, channels: twoDifferent(wellFormed) }),
  ({ secret, channels: [channel, other] }) =>
    Effect.promise(async () => {
      const token = await Effect.runPromise(hookToken(secret, other));
      expect(await Effect.runPromise(hookTokenValid(secret, channel, token))).toBe(false);
    }),
);

property(
  "a token made with another secret is refused",
  Arbitrary.all({ secrets: twoDifferent(secretText), channel: wellFormed }),
  ({ secrets: [secret, other], channel }) =>
    Effect.promise(async () => {
      const token = await Effect.runPromise(hookToken(other, channel));
      expect(await Effect.runPromise(hookTokenValid(secret, channel, token))).toBe(false);
    }),
);

property(
  "a token cut short, grown, or with one character changed is refused",
  Arbitrary.all({
    secret: secretText,
    channel: wellFormed,
    edit: Arbitrary.schema(Schema.Literals(["cut", "grow", "swap", "empty"])),
    at: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 42 }))),
  }),
  ({ secret, channel, edit, at }) =>
    Effect.promise(async () => {
      const token = await Effect.runPromise(hookToken(secret, channel));
      const swapped = token[at] === "A" ? "B" : "A";
      const forged =
        edit === "cut"
          ? token.slice(0, at)
          : edit === "grow"
            ? token + BASE64URL_ALPHABET[at]
            : edit === "swap"
              ? token.slice(0, at) + swapped + token.slice(at + 1)
              : "";
      expect(await Effect.runPromise(hookTokenValid(secret, channel, forged))).toBe(false);
    }),
);

property(
  "with an empty secret no link is signed and no token is accepted",
  Arbitrary.all({ channel: wellFormed, token: wellFormed }),
  ({ channel, token }) =>
    Effect.promise(async () => {
      expect(await Effect.runPromise(Effect.flip(hookToken("", channel)))).toBeInstanceOf(
        HookSecretMissing,
      );
      expect(await Effect.runPromise(hookTokenValid("", channel, token))).toBe(false);
    }),
);
