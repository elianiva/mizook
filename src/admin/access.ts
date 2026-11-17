import { Effect, Schema } from "effect";
import { AccessDenied } from "../errors.ts";

const Jwk = Schema.Struct({
  kid: Schema.String,
  kty: Schema.String,
  n: Schema.String,
  e: Schema.String,
});
type Jwk = typeof Jwk.Type;

const Jwks = Schema.Struct({ keys: Schema.Array(Jwk) });

const Header = Schema.Struct({ alg: Schema.String, kid: Schema.optional(Schema.String) });

const Claims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  exp: Schema.Finite,
  nbf: Schema.optional(Schema.Finite),
  email: Schema.optional(Schema.String),
});

const decoder = new TextDecoder();

const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> => {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

const decodeJson = <S extends Schema.Decoder<unknown>>(schema: S, part: string) =>
  Effect.try({
    try: () => JSON.parse(decoder.decode(fromBase64Url(part))) as unknown,
    catch: () => new AccessDenied({ reason: "token is not valid JSON" }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema as never)),
    Effect.mapError((e) =>
      e instanceof AccessDenied ? e : new AccessDenied({ reason: "bad token" }),
    ),
  ) as Effect.Effect<S["Type"], AccessDenied>;

export interface AccessConfig {
  /** `<team>.cloudflareaccess.com`, with or without `https://`. */
  readonly teamDomain: string;
  /** The Access application's audience tag. */
  readonly aud: string;
}

export interface Verifier {
  /** The signed-in user's email, or a denial. */
  readonly verify: (token: string | null) => Effect.Effect<string, AccessDenied>;
}

const CACHE_MS = 10 * 60_000;

/**
 * Checks the `Cf-Access-Jwt-Assertion` token against the team's published keys. Only RS256 is
 * accepted, the signature is checked before any claim is read, and the issuer and audience must
 * match this Access application.
 *
 * `fetchKeys` and `now` are parameters so a test can supply its own.
 */
export const makeVerifier = (
  config: AccessConfig,
  fetchKeys: (url: string) => Promise<unknown> = async (url) => (await fetch(url)).json(),
  now: () => number = Date.now,
): Verifier => {
  const issuer = `https://${config.teamDomain.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  let cache: { keys: ReadonlyArray<Jwk>; at: number } | undefined;

  const keys = (force: boolean) =>
    Effect.gen(function* () {
      if (!force && cache && now() - cache.at < CACHE_MS) return cache.keys;
      const body = yield* Effect.tryPromise(() => fetchKeys(`${issuer}/cdn-cgi/access/certs`));
      const parsed = yield* Schema.decodeUnknownEffect(Jwks)(body);
      cache = { keys: parsed.keys, at: now() };
      return parsed.keys;
    }).pipe(Effect.mapError(() => new AccessDenied({ reason: "could not load the team keys" })));

  const keyFor = (kid: string | undefined) =>
    Effect.gen(function* () {
      const find = (list: ReadonlyArray<Jwk>) => list.find((k) => k.kid === kid);
      const found = find(yield* keys(false)) ?? find(yield* keys(true));
      return found ?? (yield* new AccessDenied({ reason: "unknown signing key" }));
    });

  return {
    verify: (token) =>
      Effect.gen(function* () {
        if (!token) return yield* new AccessDenied({ reason: "no token" });
        const parts = token.split(".");
        if (parts.length !== 3) return yield* new AccessDenied({ reason: "malformed token" });
        const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

        const header = yield* decodeJson(Header, rawHeader);
        // Never let the token pick the algorithm: `none` and HS256 would skip or fake the check.
        if (header.alg !== "RS256") return yield* new AccessDenied({ reason: "unsupported alg" });

        const jwk = yield* keyFor(header.kid);
        const valid = yield* Effect.tryPromise({
          try: async () => {
            const key = await crypto.subtle.importKey(
              "jwk",
              { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
              { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
              false,
              ["verify"],
            );
            return crypto.subtle.verify(
              "RSASSA-PKCS1-v1_5",
              key,
              fromBase64Url(rawSignature),
              new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
            );
          },
          catch: () => new AccessDenied({ reason: "bad signature" }),
        });
        if (!valid) return yield* new AccessDenied({ reason: "bad signature" });

        const claims = yield* decodeJson(Claims, rawPayload);
        const seconds = now() / 1000;
        if (claims.iss !== issuer) return yield* new AccessDenied({ reason: "wrong issuer" });
        const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
        if (!audiences.includes(config.aud))
          return yield* new AccessDenied({ reason: "wrong audience" });
        if (claims.exp <= seconds) return yield* new AccessDenied({ reason: "expired" });
        if (claims.nbf !== undefined && claims.nbf > seconds)
          return yield* new AccessDenied({ reason: "not yet valid" });
        return claims.email ?? "unknown";
      }),
  };
};
