/**
 * Calls the Telegram bot API. Telegram is occasionally unreachable from CI, and its rate limit
 * answers with 429, so network failures and temporary server errors are retried with backoff.
 * A permanent answer, such as a bad token, comes back at once.
 */
export interface TelegramReply {
  readonly ok: boolean;
  readonly description?: string;
  readonly parameters?: { readonly retry_after?: number };
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const backoff = (attempt: number, reply: TelegramReply | undefined): number => {
  if (reply?.parameters?.retry_after !== undefined) {
    return Math.min(reply.parameters.retry_after * 1000, 30_000);
  }
  return Math.min(1_000 * 2 ** (attempt - 1), 10_000);
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
  const attempts = options.attempts ?? 5;
  const sleep = options.sleep ?? sleepFor;
  let last = "no attempt";

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
      const temporary = response.status === 429 || response.status >= 500;
      if (!temporary) return reply;
      last = reply.description ?? `HTTP ${response.status}`;
    } catch (cause) {
      last = cause instanceof Error ? cause.message : String(cause);
    }
    if (attempt < attempts) await sleep(backoff(attempt, reply));
  }

  throw new Error(`Telegram ${method} failed after ${attempts} attempts: ${last}`);
};
