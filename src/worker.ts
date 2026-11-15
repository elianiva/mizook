import type { Env } from "./env.ts";
import { channelOf } from "./route.ts";

export { ChatAgent } from "./chat-agent.ts";

/** Constant-time comparison of two secrets of any length. */
const sameSecret = async (a: string, b: string): Promise<boolean> => {
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all(
    [a, b].map((s) => crypto.subtle.digest("SHA-256", encoder.encode(s))),
  );
  return crypto.subtle.timingSafeEqual(x!, y!);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/telegram/webhook" && request.method === "POST") {
      // Turn away anything Telegram did not send before it wakes the chat.
      const secret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (!(await sameSecret(secret, env.MIZOOK_WEBHOOK_SECRET))) {
        return new Response("Unauthorized", { status: 401 });
      }
      // One Durable Object per forum topic: each topic is its own endless chat.
      const body = await request.text();
      let update: unknown;
      try {
        update = JSON.parse(body);
      } catch {
        return new Response("Bad request", { status: 400 });
      }
      return env.ChatAgent.getByName(channelOf(update)).fetch(
        new Request(request.url, { method: "POST", headers: request.headers, body }),
      );
    }

    if (pathname === "/") return new Response("mizook");
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
