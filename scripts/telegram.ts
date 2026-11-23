import { Data, Duration, Effect } from "effect";

export interface TelegramReply {
  readonly ok: boolean;
  readonly description?: string;
  readonly parameters?: { readonly retry_after?: number };
}

const DEFAULT_ATTEMPTS = 5;
const FIRST_RETRY_DELAY_MS = 1_000;
const LONGEST_EXPONENTIAL_DELAY_MS = 10_000;
const LONGEST_RATE_LIMIT_WAIT_MS = 30_000;
const HTTP_TOO_MANY_REQUESTS = 429;
const FIRST_SERVER_ERROR_STATUS = 500;

const isRateLimitedOrServerError = (status: number): boolean =>
  status === HTTP_TOO_MANY_REQUESTS || status >= FIRST_SERVER_ERROR_STATUS;

const retryDelayMs = (attempt: number, reply: TelegramReply | undefined): number => {
  const rateLimitWaitSeconds = reply?.parameters?.retry_after;
  if (rateLimitWaitSeconds !== undefined) {
    return Math.min(Math.round(rateLimitWaitSeconds * 1000), LONGEST_RATE_LIMIT_WAIT_MS);
  }
  return Math.min(FIRST_RETRY_DELAY_MS * 2 ** (attempt - 1), LONGEST_EXPONENTIAL_DELAY_MS);
};

export class TelegramCallError extends Data.TaggedError("TelegramCallError")<{
  readonly method: string;
  readonly attempts: number;
  readonly reason: string;
}> {
  override get message(): string {
    return `Telegram ${this.method} failed after ${this.attempts} attempts: ${this.reason}`;
  }
}

class TelegramNetworkError extends Data.TaggedError("TelegramNetworkError")<{
  readonly reason: string;
}> {}

type Attempt =
  | { readonly done: true; readonly reply: TelegramReply }
  | { readonly done: false; readonly reply: TelegramReply; readonly reason: string };

const sendOnce = (token: string, method: string, body: unknown) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      return { status: response.status, reply: (await response.json()) as TelegramReply };
    },
    catch: (cause) =>
      new TelegramNetworkError({ reason: cause instanceof Error ? cause.message : String(cause) }),
  }).pipe(
    Effect.map(({ status, reply }): Attempt => {
      if (reply.ok || !isRateLimitedOrServerError(status)) return { done: true, reply };
      return { done: false, reply, reason: reply.description ?? `HTTP ${status}` };
    }),
  );

/** Calls a Telegram Bot API method, retrying network failures, rate limits and server errors. */
export const callTelegramEffect = (
  token: string,
  method: string,
  body: unknown,
  options: {
    readonly attempts?: number;
    readonly sleep?: (ms: number) => Effect.Effect<void>;
  } = {},
): Effect.Effect<TelegramReply, TelegramCallError> => {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const sleep = options.sleep ?? ((ms: number) => Effect.sleep(Duration.millis(ms)));

  const run = (
    attempt: number,
    lastFailure: string,
  ): Effect.Effect<TelegramReply, TelegramCallError> =>
    attempt > attempts
      ? Effect.fail(new TelegramCallError({ method, attempts, reason: lastFailure }))
      : sendOnce(token, method, body).pipe(
          Effect.catchTag("TelegramNetworkError", (failure) =>
            Effect.succeed({ done: false, reason: failure.reason } as const),
          ),
          Effect.flatMap((result) => {
            if (result.done) return Effect.succeed(result.reply);
            const reply = "reply" in result ? result.reply : undefined;
            const wait = attempt < attempts ? sleep(retryDelayMs(attempt, reply)) : Effect.void;
            return wait.pipe(Effect.andThen(run(attempt + 1, result.reason)));
          }),
        );

  return run(1, "no attempt");
};

export const callTelegram = (
  token: string,
  method: string,
  body: unknown,
  options: {
    readonly attempts?: number;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<TelegramReply> => {
  const { sleep } = options;
  return Effect.runPromise(
    callTelegramEffect(token, method, body, {
      ...(options.attempts !== undefined && { attempts: options.attempts }),
      ...(sleep !== undefined && { sleep: (ms) => Effect.promise(() => sleep(ms)) }),
    }),
  );
};
