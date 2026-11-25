import { expect, test, vi } from "vite-plus/test";
import type { Env } from "../src/env.ts";

vi.mock("../src/admin/access.ts", () => ({ accessWho: async () => "me@example.com" }));

const { serveWebMedia, uploadWebMedia } = await import("../src/uploads.ts");

const bytes = new Uint8Array([137, 80, 78, 71]);

const envWith = (files: {
  put: (key: string, body: Uint8Array, options: unknown) => Promise<void>;
  get: (key: string) => Promise<unknown>;
}) => ({ Files: files, CHAT_ACCESS_AUD: "aud" }) as unknown as Env;

test("an uploaded image lands in the web inbox and comes back with its type", async () => {
  const put = vi.fn(async () => undefined);
  const env = envWith({ put, get: async () => null });
  const request = new Request("https://mzk.test/c/upload", {
    method: "POST",
    headers: {
      "content-type": "image/png",
      "x-mizook-name": encodeURIComponent("Screenshot one.png"),
    },
    body: bytes,
  });
  const response = await uploadWebMedia(request, env);
  expect(response.status).toBe(200);
  const attachment = (await response.json()) as {
    key: string;
    name: string;
    type: string;
    size: number;
  };
  expect(attachment).toEqual({
    key: expect.stringMatching(/^inbox\/web\/[\w-]+\.png$/),
    name: "Screenshot one.png",
    type: "image/png",
    size: bytes.length,
  });
  expect(put).toHaveBeenCalledWith(attachment.key, bytes, {
    httpMetadata: { contentType: "image/png" },
  });

  const get = vi.fn(async () => ({
    body: bytes,
    size: bytes.length,
    httpMetadata: { contentType: "image/png" },
  }));
  const file = attachment.key.split("/").at(-1) ?? "";
  const served = await serveWebMedia(
    new Request(`https://mzk.test/c/media/${file}`),
    envWith({ put: async () => undefined, get }),
    file,
  );
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
  expect(get).toHaveBeenCalledWith(attachment.key);
});

test("a file that is not a supported image is refused before storage", async () => {
  const put = vi.fn(async () => undefined);
  const response = await uploadWebMedia(
    new Request("https://mzk.test/c/upload", {
      method: "POST",
      headers: { "content-type": "image/svg+xml" },
      body: "<svg></svg>",
    }),
    envWith({ put, get: async () => null }),
  );
  expect(response.status).toBe(415);
  expect(put).not.toHaveBeenCalled();
});

test("an empty image is refused", async () => {
  const response = await uploadWebMedia(
    new Request("https://mzk.test/c/upload", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array(),
    }),
    envWith({ put: async () => undefined, get: async () => null }),
  );
  expect(response.status).toBe(400);
});
