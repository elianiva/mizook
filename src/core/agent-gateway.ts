import { Context, Effect, Layer } from "effect";
import { getAgentByName } from "agents";
import type { Env } from "./env";
import { WorkersEnv } from "./workers-env";
import { AgentLookupError } from "./errors";
import type { MizookAgent } from "./agent";

// The DO-stub the agents-sdk hands back; retains the agent's callable surface.
export type AgentStub = DurableObjectStub<MizookAgent>;

// Single place that turns a chat id into the per-chat DurableObject agent.
// Removes the duplicated getAgentByName + AgentLookupError wrapping that lived
// in bot.ts.
export class AgentGateway extends Context.Service<
  AgentGateway,
  {
    lookup(chatId: string): Effect.Effect<AgentStub, AgentLookupError>;
  }
>()("mizook/AgentGateway") {
  static readonly layer = Layer.effect(AgentGateway)(
    Effect.gen(function* () {
      const { env } = yield* WorkersEnv;
      return AgentGateway.of({
        lookup: (chatId) =>
          Effect.gen(function* () {
            yield* Effect.logInfo(`lookup_called chat_id=${chatId}`);
            const stub = yield* Effect.tryPromise({
              try: () => getAgentByName<Env, MizookAgent>(env.MIZOOK_AGENT, chatId),
              catch: (cause) => new AgentLookupError({ cause }),
            });
            yield* Effect.logInfo(`lookup_completed chat_id=${chatId}`);
            return stub;
          }),
      });
    }),
  );
}
