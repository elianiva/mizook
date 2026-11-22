import { Arbitrary, Effect, Schema } from "effect";
import { afterEach, expect, vi } from "vite-plus/test";
import { callTelegram, type TelegramReply } from "../scripts/telegram.ts";
import { property } from "./property.ts";

afterEach(() => vi.unstubAllGlobals());

const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));

const word = Arbitrary.schema(
  Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9]+$/), Schema.isMaxLength(10)),
);

const outcome = Arbitrary.all({
  kind: Arbitrary.schema(Schema.Literals(["network", "rateLimit", "server", "permanent", "ok"])),
  retryAfterCentiseconds: Arbitrary.flatMap(Arbitrary.schema(Schema.Boolean), (fractional) =>
    fractional
      ? Arbitrary.schema(Schema.Literals([201, 203, 402, 403, 406, 407, 803, 1617]))
      : int(0, 4_000),
  ),
  serverStatus: int(500, 599),
  permanentStatus: Arbitrary.schema(Schema.Literals([200, 400, 401, 403, 404, 428, 430, 499])),
  description: Arbitrary.all([word, Arbitrary.schema(Schema.Boolean)]).pipe(
    Arbitrary.map(([text, present]) => (present ? text : undefined)),
  ),
});

type Outcome = typeof outcome extends Arbitrary.Arbitrary<infer A> ? A : never;

const scenario = Arbitrary.all({
  outcomes: Arbitrary.array(outcome, { minLength: 1, maxLength: 8 }),
  attempts: int(1, 7),
  token: word,
  method: word,
  body: Arbitrary.schema(Schema.Record(Schema.String, Schema.Json)),
});

const reply = (o: Outcome): { status: number; body: TelegramReply } => {
  switch (o.kind) {
    case "rateLimit":
      return {
        status: 429,
        body: {
          ok: false,
          description: "Too Many Requests",
          parameters: { retry_after: o.retryAfterCentiseconds / 100 },
        },
      };
    case "server":
      return {
        status: o.serverStatus,
        body: { ok: false, ...(o.description ? { description: o.description } : {}) },
      };
    case "permanent":
      return {
        status: o.permanentStatus,
        body: { ok: false, description: o.description ?? "Bad Request" },
      };
    default:
      return { status: 200, body: { ok: true } };
  }
};

const expectedRun = (outcomes: ReadonlyArray<Outcome>, attempts: number) => {
  const sleeps: number[] = [];
  let failure = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const o: Outcome = outcomes[attempt - 1] ?? { ...outcomes[0]!, kind: "ok" };
    if (o.kind === "ok" || o.kind === "permanent") {
      return { calls: attempt, sleeps, result: { reply: reply(o).body } as const };
    }
    failure =
      o.kind === "network"
        ? "fetch failed"
        : o.kind === "rateLimit"
          ? "Too Many Requests"
          : (o.description ?? `HTTP ${o.serverStatus}`);
    if (attempt < attempts) {
      sleeps.push(
        o.kind === "rateLimit"
          ? Math.min(o.retryAfterCentiseconds * 10, 30_000)
          : Math.min(1_000 * 2 ** (attempt - 1), 10_000),
      );
    }
  }
  return { calls: attempts, sleeps, result: { failure } as const };
};

property(
  "a call retries network failures, rate limits and server errors with the right waits, returns the first success or permanent answer, and gives up after the last attempt",
  scenario,
  ({ outcomes, attempts, token, method, body }) =>
    Effect.promise(async () => {
      const requests: Array<{ url: string; body: unknown }> = [];
      vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
        requests.push({ url, body: JSON.parse(init.body) });
        const o: Outcome = outcomes[requests.length - 1] ?? { ...outcomes[0]!, kind: "ok" };
        if (o.kind === "network") throw new TypeError("fetch failed");
        const { status, body: payload } = reply(o);
        return Response.json(payload, { status });
      });
      const sleeps: number[] = [];
      const expected = expectedRun(outcomes, attempts);
      const outcomeOfCall = await callTelegram(token, method, body, {
        attempts,
        sleep: async (ms) => void sleeps.push(ms),
      }).then(
        (value) => ({ reply: value }),
        (error: Error) => ({ error: error.message }),
      );
      if ("failure" in expected.result) {
        expect(outcomeOfCall).toEqual({
          error: `Telegram ${method} failed after ${attempts} attempts: ${expected.result.failure}`,
        });
      } else {
        expect(outcomeOfCall).toEqual(expected.result);
      }
      expect(requests).toHaveLength(expected.calls);
      expect(sleeps).toEqual(expected.sleeps);
      for (const request of requests) {
        expect(request).toEqual({
          url: `https://api.telegram.org/bot${token}/${method}`,
          body: JSON.parse(JSON.stringify(body)),
        });
      }
    }),
  { size: 20 },
);
