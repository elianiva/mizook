const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

export const hookToken = async (secret: string, channel: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const hmacOfChannelName = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`hook:${channel}`)),
  );
  return toBase64Url(hmacOfChannelName);
};

const sameLengthBytesEqualInConstantTime = (left: Uint8Array, right: Uint8Array): boolean =>
  left.reduce((diff, byte, i) => diff | (byte ^ right[i]!), 0) === 0;

export const hookTokenValid = async (
  secret: string,
  channel: string,
  token: string,
): Promise<boolean> => {
  const [expectedDigest, givenDigest] = await Promise.all(
    [await hookToken(secret, channel), token].map((s) =>
      crypto.subtle.digest("SHA-256", encoder.encode(s)),
    ),
  );
  return sameLengthBytesEqualInConstantTime(
    new Uint8Array(expectedDigest!),
    new Uint8Array(givenDigest!),
  );
};
