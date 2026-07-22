import type { ToolDefinition } from "../registry/types";

export interface PromptInput {
  readonly basePrompt: string;
  readonly tools: ReadonlyArray<ToolDefinition>;
  readonly mcpServers: ReadonlyArray<string>;
  readonly userPreferences?: string | null;
}

/** Compose the system prompt from available context. Uses plain text (no markdown). */
export const composePrompt = (input: PromptInput): string => {
  const sections: Array<string> = [input.basePrompt];

  if (input.tools.length > 0) {
    const toolLines = input.tools.map((t) => `- ${t.name}: ${t.description}`);
    sections.push("Available tools:\n" + toolLines.join("\n"));
  }

  if (input.mcpServers.length > 0) {
    sections.push(
      `Connected external services: ${input.mcpServers.join(", ")}. ` +
        `Use the search and execute tools to interact with them.`,
    );
  }

  if (input.userPreferences) {
    sections.push(`---\nUser preferences:\n${input.userPreferences}`);
  }

  return sections.join("\n\n");
};
