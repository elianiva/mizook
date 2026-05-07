import { getGatewayStub } from "discord-gateway-cloudflare-do";
import type { Env } from "../../env";

export async function connectDiscordGateway(env: Env, origin: string) {
  const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY }) as any;
  return Response.json(
    await gateway.connect({
      botToken: env.DISCORD_BOT_TOKEN,
      webhookUrl: `${origin}/webhooks/discord`,
    }),
  );
}

export async function getDiscordGatewayStatus(env: Env) {
  const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY }) as any;
  return Response.json(await gateway.status());
}

export async function disconnectDiscordGateway(env: Env) {
  const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY }) as any;
  return Response.json(await gateway.disconnect());
}
