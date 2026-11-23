import { Effect, Schema } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import type { Env } from "../env.ts";
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
  readonly teamDomain: string;
  readonly aud: string;
}

export interface Verifier {
  readonly verify: (token: string | null) => Effect.Effect<string, AccessDenied>;
}

const TEAM_KEYS_CACHE_MS = 10 * 60_000;
const PINNED_ALGORITHM_NEVER_FROM_TOKEN = "RS256";

export const makeVerifier = (
  config: AccessConfig,
  fetchKeys: (url: string) => Promise<unknown> = (url) =>
    Effect.runPromise(
      HttpClient.get(url).pipe(
        Effect.flatMap((response) => response.json),
        Effect.provide(FetchHttpClient.layer),
      ),
    ),
  now: () => number = Date.now,
): Verifier => {
  const issuer = `https://${config.teamDomain.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  let cache: { keys: ReadonlyArray<Jwk>; at: number } | undefined;

  const teamKeys = (bypassCache: boolean) =>
    Effect.gen(function* () {
      if (!bypassCache && cache && now() - cache.at < TEAM_KEYS_CACHE_MS) return cache.keys;
      const body = yield* Effect.tryPromise(() => fetchKeys(`${issuer}/cdn-cgi/access/certs`));
      const parsed = yield* Schema.decodeUnknownEffect(Jwks)(body);
      cache = { keys: parsed.keys, at: now() };
      return parsed.keys;
    }).pipe(Effect.mapError(() => new AccessDenied({ reason: "could not load the team keys" })));

  const keyFor = (kid: string | undefined) =>
    Effect.gen(function* () {
      const find = (list: ReadonlyArray<Jwk>) => list.find((k) => k.kid === kid);
      const found = find(yield* teamKeys(false)) ?? find(yield* teamKeys(true));
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
        if (header.alg !== PINNED_ALGORITHM_NEVER_FROM_TOKEN)
          return yield* new AccessDenied({ reason: "unsupported alg" });

        const jwk = yield* keyFor(header.kid);
        const signatureIsValid = yield* Effect.tryPromise({
          try: async () => {
            const key = await crypto.subtle.importKey(
              "jwk",
              {
                kty: jwk.kty,
                n: jwk.n,
                e: jwk.e,
                alg: PINNED_ALGORITHM_NEVER_FROM_TOKEN,
                ext: true,
              },
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
        if (!signatureIsValid) return yield* new AccessDenied({ reason: "bad signature" });

        const claims = yield* decodeJson(Claims, rawPayload);
        const nowSeconds = now() / 1000;
        if (claims.iss !== issuer) return yield* new AccessDenied({ reason: "wrong issuer" });
        const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
        if (!audiences.includes(config.aud))
          return yield* new AccessDenied({ reason: "wrong audience" });
        if (claims.exp <= nowSeconds) return yield* new AccessDenied({ reason: "expired" });
        if (claims.nbf !== undefined && claims.nbf > nowSeconds)
          return yield* new AccessDenied({ reason: "not yet valid" });
        return claims.email ?? "unknown";
      }),
  };
};

const verifiers = new Map<string, Verifier>();

/** The verifier for an Access application, reused across requests. */
export const verifierFor = (
  env: Env,
  aud: string | undefined = env.ACCESS_AUD,
): Verifier | undefined => {
  if (!env.ACCESS_TEAM_DOMAIN || !aud) return undefined;
  const key = `${env.ACCESS_TEAM_DOMAIN}|${aud}`;
  const cached = verifiers.get(key);
  if (cached !== undefined) return cached;
  const made = makeVerifier({ teamDomain: env.ACCESS_TEAM_DOMAIN, aud });
  verifiers.set(key, made);
  return made;
};

/** The email Access signed for this request, or undefined when it is not valid. */
export const accessWho = async (
  request: Request,
  env: Env,
  aud: string | undefined = env.ACCESS_AUD,
): Promise<string | undefined> => {
  const found = verifierFor(env, aud);
  if (!found) return undefined;
  return Effect.runPromise(
    found
      .verify(request.headers.get("cf-access-jwt-assertion"))
      .pipe(Effect.match({ onSuccess: (email) => email, onFailure: () => undefined })),
  );
};
