import { Effect } from "effect";
import { getGatewayStub } from "discord-gateway-cloudflare-do";
import type { Env } from "../../env";
import { createScopedLogger } from "../../logger";

interface GatewayStub {
  connect(params: { botToken: string; webhookUrl: string }): Promise<Record<string, unknown>>;
  status(): Promise<Record<string, unknown>>;
  disconnect(): Promise<Record<string, unknown>>;
}

export function connectDiscordGateway(env: Env, origin: string) {
  const log = createScopedLogger({ action: "connect_gateway" });
  return Effect.gen(function* () {
    const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY }) as unknown as GatewayStub;
    const result = yield* Effect.tryPromise(() =>
      gateway.connect({
        botToken: env.DISCORD_BOT_TOKEN,
        webhookUrl: `${origin}/webhooks/discord`,
      }),
    );
    log.set({ detail: { result } });
    log.emit({ message: "gateway_connected" });
    return Response.json(result);
  }).pipe(Effect.runPromise);
}

export function getDiscordGatewayStatus(env: Env) {
  const log = createScopedLogger({ action: "gateway_status" });
  return Effect.gen(function* () {
    const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY }) as unknown as GatewayStub;
    const result = yield* Effect.tryPromise(() => gateway.status());
    log.set({ detail: { status: result } });
    log.emit({ message: "gateway_status_fetched" });
    return Response.json(result);
  }).pipe(Effect.runPromise);
}

export function disconnectDiscordGateway(env: Env) {
  const log = createScopedLogger({ action: "disconnect_gateway" });
  return Effect.gen(function* () {
    const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY }) as unknown as GatewayStub;
    const result = yield* Effect.tryPromise(() => gateway.disconnect());
    log.set({ detail: { result } });
    log.emit({ message: "gateway_disconnected" });
    return Response.json(result);
  }).pipe(Effect.runPromise);
}
