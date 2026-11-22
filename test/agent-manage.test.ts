import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { applyAgentAction, encodeAgentAction, type AgentAction } from "../src/agent-manage.ts";
import type { AgentInfo, AgentSpec } from "../src/host.ts";
import { fakeHost } from "./fake-host.ts";

const made = (slug: string): AgentInfo => ({
  id: `id_${slug}`,
  slug,
  name: slug,
  role: "",
  persona: "",
  tools: undefined,
  doName: `agent:id_${slug}`,
  isDefault: false,
  bound: [],
  created: 0,
  lastActive: 0,
});

/** Apply an action against a host that records what it was asked to do. */
const apply = (action: AgentAction, fail?: string) => {
  const calls: unknown[][] = [];
  const host = fakeHost({
    createAgent: (spec: AgentSpec) =>
      Effect.sync(() => {
        calls.push(["create", spec]);
        return fail ? { ok: false, error: fail } : { ok: true, agent: made(spec.slug) };
      }),
    updateAgent: (key, patch) =>
      Effect.sync(() => {
        calls.push(["update", key, patch]);
        return { ok: true, agent: made(patch.slug ?? key) };
      }),
    deleteAgent: (key) =>
      Effect.sync(() => {
        calls.push(["delete", key]);
        return { ok: true, agent: made(key) };
      }),
    setAgentSetting: (doName, key, value) =>
      Effect.sync(() => void calls.push(["set", doName, key, value])),
    reloadAgent: (doName) => Effect.sync(() => void calls.push(["reload", doName])),
  });
  return Effect.runPromise(applyAgentAction(host, encodeAgentAction(action))).then((said) => ({
    said,
    calls,
  }));
};

test("an approved create makes the agent, then sets its model on the new agent", async () => {
  const { said, calls } = await apply({
    op: "create",
    slug: "grok",
    role: "Check claims.",
    tools: ["web_search"],
    model: "deepseek-pro",
  });
  expect(calls).toEqual([
    [
      "create",
      { slug: "grok", name: "grok", role: "Check claims.", persona: "", tools: ["web_search"] },
    ],
    ["set", "agent:id_grok", "model", "deepseek-pro"],
  ]);
  expect(said).toBe("Created /grok (grok).");
});

test("an update changes only the fields given, gives back every tool on null, and reloads the agent", async () => {
  const { calls } = await apply({ op: "update", slug: "grok", newSlug: "fact", tools: null });
  expect(calls).toEqual([
    ["update", "grok", { slug: "fact", tools: null }],
    ["reload", "agent:id_fact"],
  ]);
});

test("a refused change says why and touches nothing else", async () => {
  const { said, calls } = await apply(
    { op: "create", slug: "help", model: "x" },
    "/help is already a command",
  );
  expect(said).toBe("It failed: /help is already a command.");
  expect(calls).toHaveLength(1);
});

test("a delete sets nothing on the agent it removed", async () => {
  const { said, calls } = await apply({ op: "delete", slug: "grok", model: "x" });
  expect(calls).toEqual([["delete", "grok"]]);
  expect(said).toBe("Deleted /grok.");
});
