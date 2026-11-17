import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { makeVerifier } from "../src/admin/access.ts";

const TEAM = "me.cloudflareaccess.com";
const AUD = "aud-1";
const NOW = 1_800_000_000_000;

const b64 = (data: string | ArrayBuffer) =>
  btoa(typeof data === "string" ? data : String.fromCharCode(...new Uint8Array(data)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

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
  return { pair, jwk: { kid: "k1", kty: "RSA", n: jwk.n!, e: jwk.e! } };
};

const sign = async (
  key: CryptoKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: "k1" },
) => {
  const body = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body));
  return `${body}.${b64(sig)}`;
};

const good = { iss: `https://${TEAM}`, aud: [AUD], exp: NOW / 1000 + 60, email: "me@example.com" };

const setup = async () => {
  const { pair, jwk } = await rsa();
  const other = await rsa();
  const verifier = makeVerifier(
    { teamDomain: TEAM, aud: AUD },
    async () => ({ keys: [jwk] }),
    () => NOW,
  );
  const run = (token: string | null) =>
    Effect.runPromise(
      verifier
        .verify(token)
        .pipe(Effect.match({ onSuccess: (e) => e, onFailure: (e) => `denied: ${e.reason}` })),
    );
  return { pair, other, run };
};

test("a token Access signed for this application passes and names the user", async () => {
  const { pair, run } = await setup();
  expect(await run(await sign(pair.privateKey, good))).toBe("me@example.com");
});

test("every way a token can be wrong is denied", async () => {
  const { pair, other, run } = await setup();
  expect(await run(null)).toBe("denied: no token");
  expect(await run(await sign(other.pair.privateKey, good))).toBe("denied: bad signature");
  expect(await run(await sign(pair.privateKey, { ...good, aud: ["other"] }))).toBe(
    "denied: wrong audience",
  );
  expect(await run(await sign(pair.privateKey, { ...good, iss: "https://evil.example" }))).toBe(
    "denied: wrong issuer",
  );
  expect(await run(await sign(pair.privateKey, { ...good, exp: NOW / 1000 - 1 }))).toBe(
    "denied: expired",
  );
  expect(await run(await sign(pair.privateKey, { ...good, nbf: NOW / 1000 + 5 }))).toBe(
    "denied: not yet valid",
  );
  expect(await run(await sign(pair.privateKey, good, { alg: "HS256", kid: "k1" }))).toBe(
    "denied: unsupported alg",
  );
  expect(await run(await sign(pair.privateKey, good, { alg: "none" }))).toBe(
    "denied: unsupported alg",
  );
  expect(await run(await sign(pair.privateKey, good, { alg: "RS256", kid: "nope" }))).toBe(
    "denied: unknown signing key",
  );
  expect(await run("a.b")).toBe("denied: malformed token");
});
