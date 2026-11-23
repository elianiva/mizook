import { Effect } from "effect";
import { HookSecretMissing } from "./errors.ts";

const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

export const hookToken = (secret: string, channel: string) =>
  Effect.gen(function* () {
    if (secret === "") return yield* new HookSecretMissing();
    const key = yield* Effect.promise(() =>
      crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    );
    const hmacOfChannelName = new Uint8Array(
      yield* Effect.promise(() =>
        crypto.subtle.sign("HMAC", key, encoder.encode(`hook:${channel}`)),
      ),
    );
    return toBase64Url(hmacOfChannelName);
  });

const sameLengthBytesEqualInConstantTime = (left: Uint8Array, right: Uint8Array): boolean =>
  left.reduce((diff, byte, i) => diff | (byte ^ right[i]!), 0) === 0;

export const hookTokenValid = (secret: string, channel: string, token: string) =>
  Effect.gen(function* () {
    const expected = yield* hookToken(secret, channel);
    const [expectedDigest, givenDigest] = yield* Effect.promise(() =>
      Promise.all([expected, token].map((s) => crypto.subtle.digest("SHA-256", encoder.encode(s)))),
    );
    return sameLengthBytesEqualInConstantTime(
      new Uint8Array(expectedDigest!),
      new Uint8Array(givenDigest!),
    );
  }).pipe(Effect.catchTag("HookSecretMissing", () => Effect.succeed(false)));
