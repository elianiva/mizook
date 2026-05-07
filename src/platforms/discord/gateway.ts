import { Effect } from "effect"
import { getGatewayStub } from "discord-gateway-cloudflare-do"
import type { Env } from "../../env"

export function connectDiscordGateway(env: Env, origin: string) {
  return Effect.gen(function*() {
    const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY }) as any
    const result = yield* Effect.tryPromise(() =>
      gateway.connect({
        botToken: env.DISCORD_BOT_TOKEN,
        webhookUrl: `${origin}/webhooks/discord`,
      }),
    )
    return Response.json(result)
  }).pipe(Effect.runPromise)
}

export function getDiscordGatewayStatus(env: Env) {
  return Effect.gen(function*() {
    const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY }) as any
    const result = yield* Effect.tryPromise(() => gateway.status())
    return Response.json(result)
  }).pipe(Effect.runPromise)
}

export function disconnectDiscordGateway(env: Env) {
  return Effect.gen(function*() {
    const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY }) as any
    const result = yield* Effect.tryPromise(() => gateway.disconnect())
    return Response.json(result)
  }).pipe(Effect.runPromise)
}
