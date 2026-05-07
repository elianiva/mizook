import { Effect } from "effect";
import { getGatewayStub } from "discord-gateway-cloudflare-do";
import type { Env } from "../../env";
import { createScopedLogger } from "../../logger";
import { GatewayError } from "../../lib/errors";

interface GatewayStub {
  connect(params: { botToken: string; webhookUrl: string }): Promise<Record<string, unknown>>;
  status(): Promise<Record<string, unknown>>;
  disconnect(): Promise<Record<string, unknown>>;
}

export function connectDiscordGateway(env: Env, origin: string) {
  const log = createScopedLogger({ action: "connect_gateway" });
  return Effect.gen(function* () {
    const gateway = yield* Effect.sync(
      () => getGatewayStub({ namespace: env.DISCORD_GATEWAY }) as unknown as GatewayStub,
    );
    const result = yield* Effect.tryPromise({
      try: () =>
        gateway.connect({
          botToken: env.DISCORD_BOT_TOKEN,
          webhookUrl: `${origin}/webhooks/discord`,
        }),
      catch: (error) => new GatewayError({ cause: error, action: "connect_gateway" }),
    });
    if ("error" in result && typeof result.error === "string") {
      return yield* Effect.fail(
        new GatewayError({ cause: result.error, action: "connect_gateway" }),
      );
    }
    log.set({ detail: { result } });
    log.emit({ message: "gateway_connected" });
    return Response.json(result);
  }).pipe(
    Effect.catchTag("GatewayError", (error) =>
      Effect.succeed(
        Response.json(
          { error: "gateway_error", action: error.action, message: String(error.cause) },
          { status: 500 },
        ),
      ),
    ),
    Effect.runPromise,
  );
}

export function getDiscordGatewayStatus(env: Env) {
  const log = createScopedLogger({ action: "gateway_status" });
  return Effect.gen(function* () {
    const gateway = yield* Effect.sync(
      () => getGatewayStub({ namespace: env.DISCORD_GATEWAY }) as unknown as GatewayStub,
    );
    const result = yield* Effect.tryPromise({
      try: () => gateway.status(),
      catch: (error) => new GatewayError({ cause: error, action: "gateway_status" }),
    });
    if ("error" in result && typeof result.error === "string") {
      return yield* Effect.fail(
        new GatewayError({ cause: result.error, action: "gateway_status" }),
      );
    }
    log.set({ detail: { status: result } });
    log.emit({ message: "gateway_status_fetched" });
    return Response.json(result);
  }).pipe(
    Effect.catchTag("GatewayError", (error) =>
      Effect.succeed(
        Response.json(
          { error: "gateway_error", action: error.action, message: String(error.cause) },
          { status: 500 },
        ),
      ),
    ),
    Effect.runPromise,
  );
}

export function disconnectDiscordGateway(env: Env) {
  const log = createScopedLogger({ action: "disconnect_gateway" });
  return Effect.gen(function* () {
    const gateway = yield* Effect.sync(
      () => getGatewayStub({ namespace: env.DISCORD_GATEWAY }) as unknown as GatewayStub,
    );
    const result = yield* Effect.tryPromise({
      try: () => gateway.disconnect(),
      catch: (error) => new GatewayError({ cause: error, action: "disconnect_gateway" }),
    });
    if ("error" in result && typeof result.error === "string") {
      return yield* Effect.fail(
        new GatewayError({ cause: result.error, action: "disconnect_gateway" }),
      );
    }
    log.set({ detail: { result } });
    log.emit({ message: "gateway_disconnected" });
    return Response.json(result);
  }).pipe(
    Effect.catchTag("GatewayError", (error) =>
      Effect.succeed(
        Response.json(
          { error: "gateway_error", action: error.action, message: String(error.cause) },
          { status: 500 },
        ),
      ),
    ),
    Effect.runPromise,
  );
}
