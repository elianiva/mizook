import { tool } from "ai";
import { z } from "zod";
import type { MizookAgent } from "../../core/agent";

export function createArtifactTools(agent: MizookAgent) {

  return {
    write_artifact: tool({
      description:
        "Create or overwrite an HTML artifact and return its public URL. " +
        "Use this to generate standalone HTML pages (calculators, dashboards, reports, etc.) " +
        "that the user can open in their browser.",
      inputSchema: z.object({
        name: z
          .string()
          .describe("Filename for the artifact (e.g. 'calculator.html')"),
        content: z
          .string()
          .describe("Full HTML content of the artifact"),
      }),
      execute: async ({ name, content }) => {
        const key = `artifacts/${name}`;
        await agent.appEnv.MIZOOK_R2.put(key, content, {
          httpMetadata: { contentType: "text/html" },
        });

        const base = agent.appEnv.BASE_URL ?? "https://mzk.elianiva.com";
        return `${base}/artifacts/${name}`;
      },
    }),
  };
}
