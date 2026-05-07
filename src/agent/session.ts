import { Effect } from "effect";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { AgentSearchProvider } from "agents/experimental/memory/session";
import { generateText } from "ai";
import type { Session } from "@cloudflare/think";
import type { MizookAgent } from "./mizook-agent";
import type { Env } from "../env";
import { createModel } from "./model";
import { createScopedLogger } from "../logger";

export function configureSession(session: Session, agent: MizookAgent, env: Env) {
  return session
    .withContext("soul", {
      description:
        "Your identity, personality, and core instructions. " +
        "Write to this with set_context to change who you are.",
      maxTokens: 1000,
    })
    .withContext("memory", {
      description:
        "Key facts, preferences, and context learned from the user. " +
        "Proactively update this as you learn new information.",
      maxTokens: 2000,
    })
    .withContext("history", {
      provider: new AgentSearchProvider(agent),
      description: "Full-text search across your conversation history with this assistant.",
    })
    .onCompaction(
      createCompactFunction({
        summarize: (prompt) => {
          const log = createScopedLogger({ action: "compaction_summarize", prompt_length: prompt.length });
          return Effect.tryPromise(() => generateText({ model: createModel(env), prompt })).pipe(
              Effect.map((r) => r.text),
              Effect.tap((text) =>
                Effect.sync(() => log.set({ detail: { summary_length: text.length } })),
              ),
              Effect.ensuring(Effect.sync(() => log.emit({ message: "compaction_done" }))),
              Effect.runPromise,
            );
        },
      }),
    )
    .compactAfter(100_000)
    .withCachedPrompt();
}
