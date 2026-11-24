import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { AgentAction, applyAgentAction, encodeAgentAction } from "../src/agent-manage.ts";
import type { AgentInfo, AgentSpec } from "../src/host.ts";
import { fakeAgents } from "./fake-host.ts";
import { property } from "./property.ts";

const made = (slug: string, name: string): AgentInfo => ({
  id: `id_${slug}`,
  slug,
  name,
  role: "",
  persona: "",
  tools: undefined,
  doName: `agent:id_${slug}`,
  isDefault: false,
  bound: [],
  created: 0,
  lastActive: 0,
});

const apply = (json: string, fail: string | undefined) => {
  const calls: unknown[][] = [];
  const answer = (agent: AgentInfo) =>
    fail === undefined ? { ok: true as const, agent } : { ok: false as const, error: fail };
  const agents = fakeAgents({
    createAgent: (spec: AgentSpec) =>
      Effect.sync(() => {
        calls.push(["create", spec]);
        return answer(made(spec.slug, spec.name));
      }),
    updateAgent: (key, patch) =>
      Effect.sync(() => {
        calls.push(["update", key, patch]);
        return answer(made(patch.slug ?? key, patch.name ?? key));
      }),
    deleteAgent: (key) =>
      Effect.sync(() => {
        calls.push(["delete", key]);
        return answer(made(key, key));
      }),
    setAgentSetting: (doName, key, value) =>
      Effect.sync(() => void calls.push(["set", doName, key, value])),
    reloadAgent: (doName) => Effect.sync(() => void calls.push(["reload", doName])),
  });
  return applyAgentAction(agents, json).pipe(Effect.map((said) => ({ said, calls })));
};

const action = Arbitrary.schema(AgentAction);

const failure = Arbitrary.all({
  fails: Arbitrary.schema(Schema.Boolean),
  error: Arbitrary.schema(Schema.String),
}).pipe(Arbitrary.map(({ fails, error }) => (fails ? error : undefined)));

const defined = <A extends object>(fields: A) =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

property(
  "an approved action asks the host for exactly the change it names, then sets the model and reloads only where that applies",
  action,
  (a) =>
    Effect.gen(function* () {
      const { said, calls } = yield* apply(encodeAgentAction(a), undefined);
      if (a.op === "delete") {
        expect(calls).toEqual([["delete", a.slug]]);
        expect(said).toBe(`Deleted /${a.slug}.`);
        return;
      }
      const slug = a.op === "create" ? a.slug : (a.newSlug ?? a.slug);
      const name = a.name ?? a.slug;
      const doName = `agent:id_${slug}`;
      const first =
        a.op === "create"
          ? [
              "create",
              defined({
                slug: a.slug,
                name: a.name ?? a.slug,
                role: a.role ?? "",
                persona: a.persona ?? "",
                tools: a.tools,
              }),
            ]
          : [
              "update",
              a.slug,
              defined({
                slug: a.newSlug,
                name: a.name,
                role: a.role,
                persona: a.persona,
                tools: a.tools,
              }),
            ];
      expect(calls).toEqual([
        first,
        ...(a.model === undefined ? [] : [["set", doName, "model", a.model]]),
        ...(a.op === "update" ? [["reload", doName]] : []),
      ]);
      expect(said).toBe(`${a.op === "create" ? "Created" : "Changed"} /${slug} (${name}).`);
    }),
);

property(
  "a refused change says why and touches nothing after the refused call",
  Arbitrary.all({ a: action, error: Arbitrary.schema(Schema.String) }),
  ({ a, error }) =>
    Effect.gen(function* () {
      const { said, calls } = yield* apply(encodeAgentAction(a), error);
      expect(said).toBe(`It failed: ${error}.`);
      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toBe(a.op);
    }),
);

property(
  "an action that is not valid JSON for an agent change fails with a message and calls nothing",
  Arbitrary.all({
    body: Arbitrary.schema(Schema.String),
    fail: failure,
    shape: Arbitrary.schema(Schema.Literals(["raw", "bad op", "no slug"])),
  }),
  ({ body, fail, shape }) =>
    Effect.gen(function* () {
      const json =
        shape === "raw"
          ? `{${body}`
          : shape === "bad op"
            ? JSON.stringify({ op: `x${body}`, slug: body })
            : JSON.stringify({ op: "create", name: body });
      const { said, calls } = yield* apply(json, fail);
      expect(said.startsWith("It failed: ")).toBe(true);
      expect(calls).toEqual([]);
    }),
);
