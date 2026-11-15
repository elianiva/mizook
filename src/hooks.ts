const encoder = new TextEncoder();

/** The secret part of a channel's webhook link: an HMAC of its name, so nothing is stored. */
export const hookToken = async (secret: string, channel: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`hook:${channel}`)),
  );
  return btoa(String.fromCharCode(...mac))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

/** Whether `token` is the token of `channel`, compared in constant time. */
export const hookTokenValid = async (
  secret: string,
  channel: string,
  token: string,
): Promise<boolean> => {
  const [a, b] = await Promise.all(
    [await hookToken(secret, channel), token].map((s) =>
      crypto.subtle.digest("SHA-256", encoder.encode(s)),
    ),
  );
  const x = new Uint8Array(a!);
  const y = new Uint8Array(b!);
  // Digests have one length, so comparing every byte takes the same time whatever differs.
  return x.reduce((diff, byte, i) => diff | (byte ^ y[i]!), 0) === 0;
};
