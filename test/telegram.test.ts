import { afterEach, expect, test, vi } from "vite-plus/test";
import { callTelegram } from "../scripts/telegram.ts";

afterEach(() => vi.unstubAllGlobals());

test("a network failure and a rate limit retry, then the call succeeds", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  vi.stubGlobal("fetch", async () => {
    calls++;
    if (calls === 1) throw new TypeError("fetch failed");
    if (calls === 2) {
      return Response.json(
        { ok: false, description: "Too Many Requests", parameters: { retry_after: 0.01 } },
        { status: 429 },
      );
    }
    return Response.json({ ok: true, result: true });
  });

  const reply = await callTelegram(
    "token",
    "setWebhook",
    {},
    {
      attempts: 3,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );

  expect(reply.ok).toBe(true);
  expect(calls).toBe(3);
  expect(sleeps).toEqual([1_000, 10]);
});

test("a permanent Telegram error comes back at once and is not retried", async () => {
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls++;
    return Response.json({ ok: false, description: "Unauthorized" }, { status: 401 });
  });

  const reply = await callTelegram("token", "setWebhook", {}, { attempts: 5 });

  expect(reply).toMatchObject({ ok: false, description: "Unauthorized" });
  expect(calls).toBe(1);
});
