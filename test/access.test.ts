import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { makeVerifier } from "../src/admin/access.ts";
import { property } from "./property.ts";

const TEAM = "me.cloudflareaccess.com";
const ISSUER = `https://${TEAM}`;
const AUD = "aud-1";
const KID = "k1";

const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));

const oneOf = <const A extends ReadonlyArray<string>>(values: A) =>
  Arbitrary.schema(Schema.Literals(values));

const nearZeroOrFar = (maximum: number) =>
  Arbitrary.flatMap(int(0, 1), (near) => (near === 0 ? int(0, 2) : int(0, maximum)));

const bytesToB64Url = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const b64 = (data: string | ArrayBuffer) =>
  bytesToB64Url(typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data));

const rsa = async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { pair, jwk: { kid: KID, kty: "RSA", n: jwk.n!, e: jwk.e! } };
};

const team = await rsa();
const stranger = await rsa();

const sign = async (
  key: CryptoKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: KID },
) => {
  const body = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body));
  return `${body}.${b64(sig)}`;
};

const verify = (token: string | null, nowMs: number, teamDomain = TEAM) =>
  makeVerifier(
    { teamDomain, aud: AUD },
    async () => ({ keys: [team.jwk] }),
    () => nowMs,
  )
    .verify(token)
    .pipe(Effect.match({ onSuccess: (e) => e, onFailure: (e) => `denied: ${e.reason}` }));

const now = Arbitrary.map(int(1_600_000_000, 2_000_000_000), (s) => s * 1000);

const glyphs = oneOf([
  "a",
  "Z",
  "0",
  ".",
  "+",
  "_",
  "é",
  "ß",
  "日",
  "本",
  "🙂",
  "\u00a0",
  '"',
  "\\",
]);
const word = Arbitrary.map(Arbitrary.array(glyphs, { minLength: 1, maxLength: 12 }), (g) =>
  g.join(""),
);
const email = Arbitrary.map(Arbitrary.all([word, word]), ([user, host]) => `${user}@${host}`);
const otherAudience = word.pipe(Arbitrary.filter((a) => a !== AUD));

const audiences = Arbitrary.flatMap(int(0, 1), (asString) =>
  asString === 0
    ? Arbitrary.Constant<string | string[]>(AUD)
    : Arbitrary.map(
        Arbitrary.all({
          before: Arbitrary.array(otherAudience, { maxLength: 3 }),
          after: Arbitrary.array(otherAudience, { maxLength: 3 }),
        }),
        ({ before, after }): string | string[] => [...before, AUD, ...after],
      ),
);

const validToken = Arbitrary.all({
  now,
  email: Arbitrary.flatMap(int(0, 3), (none) =>
    none === 0 ? Arbitrary.Constant(undefined) : email,
  ),
  aud: audiences,
  expiresIn: Arbitrary.map(nearZeroOrFar(86_400), (s) => s + 1),
  startedAgo: Arbitrary.flatMap(int(0, 1), (has) =>
    has === 0 ? Arbitrary.Constant(undefined) : nearZeroOrFar(86_400),
  ),
});

property(
  "a token the team key signed for this audience, unexpired and already valid, passes and names its user",
  validToken,
  ({ now, email, aud, expiresIn, startedAgo }) =>
    Effect.gen(function* () {
      const seconds = now / 1000;
      const token = yield* Effect.promise(() =>
        sign(team.pair.privateKey, {
          iss: ISSUER,
          aud,
          exp: seconds + expiresIn,
          ...(startedAgo !== undefined && { nbf: seconds - startedAgo }),
          ...(email !== undefined && { email }),
        }),
      );
      expect(yield* verify(token, now)).toBe(email ?? "unknown");
    }),
  { runs: 60 },
);

property(
  "the issuer matches whether the team domain is configured bare, with a scheme, or with a trailing slash",
  Arbitrary.all({ now, form: oneOf(["", "https://", "http://"]), slash: oneOf(["", "/"]) }),
  ({ now, form, slash }) =>
    Effect.gen(function* () {
      const token = yield* Effect.promise(() =>
        sign(team.pair.privateKey, {
          iss: ISSUER,
          aud: [AUD],
          exp: now / 1000 + 60,
          email: "me@x",
        }),
      );
      expect(yield* verify(token, now, `${form}${TEAM}${slash}`)).toBe("me@x");
    }),
  { runs: 20 },
);

type Fault = {
  readonly reason: string;
  readonly claims?: (seconds: number) => Record<string, unknown>;
  readonly header?: Record<string, unknown>;
  readonly key?: CryptoKey;
  readonly raw?: string | null;
  readonly tamper?: Record<string, unknown>;
};

const fault: Arbitrary.Arbitrary<Fault> = Arbitrary.flatMap(
  oneOf([
    "no token",
    "malformed",
    "alg",
    "kid",
    "stranger",
    "tampered",
    "issuer",
    "audience",
    "expired",
    "not yet",
  ]),
  (kind): Arbitrary.Arbitrary<Fault> => {
    switch (kind) {
      case "no token":
        return Arbitrary.map(int(0, 1), (empty) => ({
          reason: "no token",
          raw: empty === 0 ? null : "",
        }));
      case "malformed":
        return Arbitrary.map(
          Arbitrary.flatMap(Arbitrary.schema(Schema.Literals([1, 2, 4, 5])), (parts) =>
            Arbitrary.array(Arbitrary.schema(Schema.String), {
              minLength: parts,
              maxLength: parts,
            }),
          ).pipe(
            Arbitrary.filter(
              (parts) => !parts.some((p) => p.includes(".")) && parts.join(".") !== "",
            ),
          ),
          (parts) => ({ reason: "malformed token", raw: parts.join(".") }),
        );
      case "alg":
        return Arbitrary.map(
          Arbitrary.flatMap(int(0, 1), (pick) =>
            pick === 0
              ? oneOf(["none", "HS256", "rs256", "RS384", "ES256", "PS256", "RS256 "])
              : Arbitrary.schema(Schema.String).pipe(Arbitrary.filter((a) => a !== "RS256")),
          ),
          (alg) => ({ reason: "unsupported alg", header: { alg, kid: KID } }),
        );
      case "kid":
        return Arbitrary.map(
          Arbitrary.flatMap(int(0, 3), (none) =>
            none === 0
              ? Arbitrary.Constant(undefined)
              : Arbitrary.schema(Schema.String).pipe(Arbitrary.filter((k) => k !== KID)),
          ),
          (kid) => ({
            reason: "unknown signing key",
            header: kid === undefined ? { alg: "RS256" } : { alg: "RS256", kid },
          }),
        );
      case "stranger":
        return Arbitrary.Constant({ reason: "bad signature", key: stranger.pair.privateKey });
      case "tampered":
        return Arbitrary.map(
          email.pipe(Arbitrary.filter((e) => e !== "me@example.com")),
          (other) => ({ reason: "bad signature", tamper: { email: other } }),
        );
      case "issuer":
        return Arbitrary.map(
          oneOf([
            "https://evil.example",
            `http://${TEAM}`,
            `https://${TEAM}/`,
            `https://evil.${TEAM}`,
            TEAM,
            `https://${TEAM.toUpperCase()}`,
          ]),
          (iss) => ({ reason: "wrong issuer", claims: () => ({ iss }) }),
        );
      case "audience":
        return Arbitrary.map(
          Arbitrary.flatMap(int(0, 1), (asString) =>
            asString === 0
              ? Arbitrary.map(
                  oneOf(["aud-10", "AUD-1", "aud", " aud-1", "aud-1 "]),
                  (a): string | string[] => a,
                )
              : Arbitrary.map(
                  Arbitrary.array(otherAudience, { maxLength: 4 }),
                  (a): string | string[] => a,
                ),
          ),
          (aud) => ({ reason: "wrong audience", claims: () => ({ aud }) }),
        );
      case "expired":
        return Arbitrary.map(nearZeroOrFar(86_400 * 365), (ago) => ({
          reason: "expired",
          claims: (seconds: number) => ({ exp: seconds - ago }),
        }));
      default:
        return Arbitrary.map(
          Arbitrary.map(nearZeroOrFar(86_400), (s) => s + 1),
          (ahead) => ({
            reason: "not yet valid",
            claims: (seconds: number) => ({ nbf: seconds + ahead }),
          }),
        );
    }
  },
);

property(
  "a token wrong in any one way is denied with the reason for that way",
  Arbitrary.all({ now, fault }),
  ({ now, fault }) =>
    Effect.gen(function* () {
      const seconds = now / 1000;
      const claims = {
        iss: ISSUER,
        aud: [AUD],
        exp: seconds + 60,
        email: "me@example.com",
        ...fault.claims?.(seconds),
      };
      const token =
        fault.raw !== undefined
          ? fault.raw
          : yield* Effect.promise(async () => {
              const signed = await sign(fault.key ?? team.pair.privateKey, claims, fault.header);
              if (fault.tamper === undefined) return signed;
              const [header, , signature] = signed.split(".");
              return `${header}.${b64(JSON.stringify({ ...claims, ...fault.tamper }))}.${signature}`;
            });
      expect(yield* verify(token, now)).toBe(`denied: ${fault.reason}`);
    }),
  { runs: 80 },
);
