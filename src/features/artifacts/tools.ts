import { tool } from "ai";
import { z } from "zod";
import type { MizookAgent } from "../../core/agent";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function createArtifactTools(agent: MizookAgent) {
  return {
    list_artifacts: tool({
      description: "List all HTML artifacts stored in R2. Returns artifact names, sizes, and URLs.",
      inputSchema: z.object({}),
      execute: async () => {
        const listed = await agent.appEnv.MIZOOK_R2.list({ prefix: "artifacts/" });
        const base = agent.appEnv.BASE_URL ?? "https://mzk.elianiva.com";

        if (listed.objects.length === 0) return "No artifacts found.";

        const items = listed.objects
          .map((obj) => {
            const name = obj.key.replace("artifacts/", "");
            const size = formatSize(obj.size);
            const modified = new Date(obj.uploaded).toLocaleDateString("en-US", {
              year: "numeric",
              month: "short",
              day: "numeric",
            });
            return { name, size, modified, url: `${base}/artifacts/${encodeURIComponent(name)}` };
          })
          .sort((a, b) => a.name.localeCompare(b.name));

        return items
          .map((item) => `${item.name} (${item.size}, modified ${item.modified}) — ${item.url}`)
          .join("\n");
      },
    }),

    delete_artifact: tool({
      description:
        "Delete an HTML artifact by name. Use list_artifacts first to see available names.",
      inputSchema: z.object({
        name: z.string().describe("Filename of the artifact to delete (e.g. 'calculator.html')"),
      }),
      execute: async ({ name }) => {
        const key = `artifacts/${name}`;
        const exists = await agent.appEnv.MIZOOK_R2.head(key);
        if (!exists) return `Artifact "${name}" not found.`;

        await agent.appEnv.MIZOOK_R2.delete(key);
        return `Deleted "${name}".`;
      },
    }),

    update_artifact: tool({
      description:
        "Update an existing HTML artifact by name (alias for overwrite). " +
        "If the artifact doesn't exist, it will be created.",
      inputSchema: z.object({
        name: z.string().describe("Filename for the artifact (e.g. 'calculator.html')"),
        content: z.string().describe("Full HTML content of the artifact"),
      }),
      execute: async ({ name, content }) => {
        const key = `artifacts/${name}`;
        const existed = await agent.appEnv.MIZOOK_R2.head(key);
        await agent.appEnv.MIZOOK_R2.put(key, content, {
          httpMetadata: { contentType: "text/html" },
        });

        const base = agent.appEnv.BASE_URL ?? "https://mzk.elianiva.com";
        const action = existed ? "Updated" : "Created";
        return `${action} "${name}". URL: ${base}/artifacts/${name}`;
      },
    }),

    write_artifact: tool({
      description:
        "Create or overwrite an HTML artifact and return its public URL. " +
        "Use this to generate standalone HTML pages (calculators, dashboards, reports, etc.) " +
        "that the user can open in their browser.",
      inputSchema: z.object({
        name: z.string().describe("Filename for the artifact (e.g. 'calculator.html')"),
        content: z.string().describe("Full HTML content of the artifact"),
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
