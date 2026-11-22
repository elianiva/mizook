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

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isRateLimitedOrServerError = (status: number): boolean =>
  status === HTTP_TOO_MANY_REQUESTS || status >= FIRST_SERVER_ERROR_STATUS;

const retryDelayMs = (attempt: number, reply: TelegramReply | undefined): number => {
  const rateLimitWaitSeconds = reply?.parameters?.retry_after;
  if (rateLimitWaitSeconds !== undefined) {
    return Math.min(Math.round(rateLimitWaitSeconds * 1000), LONGEST_RATE_LIMIT_WAIT_MS);
  }
  return Math.min(FIRST_RETRY_DELAY_MS * 2 ** (attempt - 1), LONGEST_EXPONENTIAL_DELAY_MS);
};

export const callTelegram = async (
  token: string,
  method: string,
  body: unknown,
  options: {
    readonly attempts?: number;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<TelegramReply> => {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const sleep = options.sleep ?? sleepFor;
  let lastFailure = "no attempt";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let reply: TelegramReply | undefined;
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      reply = (await response.json()) as TelegramReply;
      if (reply.ok) return reply;
      const isPermanentAnswer = !isRateLimitedOrServerError(response.status);
      if (isPermanentAnswer) return reply;
      lastFailure = reply.description ?? `HTTP ${response.status}`;
    } catch (networkFailure) {
      lastFailure =
        networkFailure instanceof Error ? networkFailure.message : String(networkFailure);
    }
    if (attempt < attempts) await sleep(retryDelayMs(attempt, reply));
  }

  throw new Error(`Telegram ${method} failed after ${attempts} attempts: ${lastFailure}`);
};
