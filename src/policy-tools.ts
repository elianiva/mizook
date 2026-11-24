import { clipToolOutput } from "@mizook/memory";
import { Effect, Schema } from "effect";
import { Approvals } from "./approvals.ts";
import { ToolError } from "./errors.ts";
import { Executor, pausedExecution } from "./executor.ts";
import { describePolicy, Policies } from "./policies.ts";
import { defineTool, described } from "./tool.ts";

export const PolicyArgs = Schema.Struct({
  action: described(
    Schema.Literals(["list", "add", "remove"]),
    "list: every rule. add: save a rule. remove: delete one by id.",
  ),
  match: Schema.optionalKey(
    described(
      Schema.String,
      "add: a lowercase substring of the action, such as gmail.send, delete, or merchant.",
    ),
  ),
  decision: Schema.optionalKey(
    described(
      Schema.Literals(["allow", "ask", "deny"]),
      "add: run it, ask first, or refuse it. Deny beats ask, ask beats allow.",
    ),
  ),
  id: Schema.optionalKey(
    described(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)), "remove: the rule number."),
  ),
});

export const ExecutorArgs = Schema.Struct({
  tool: Schema.Literals(["skills", "search", "describe", "call", "execute"]),
  input: Schema.Record(Schema.String, Schema.Unknown),
});

const policyTarget = (tool: string, input: Record<string, unknown>): string => {
  const calls = Array.isArray(input.calls) ? input.calls : [];
  const paths = calls.flatMap((call) => {
    if (typeof call !== "object" || call === null || !("path" in call)) return [];
    const path = (call as { path?: unknown }).path;
    return typeof path === "string" ? [path] : [];
  });
  return [tool, ...paths].join(" ").toLowerCase();
};

export const policyTools = [
  defineTool({
    name: "policy_manage",
    path: "policies.manage",
    description:
      "Set how much rope an executor action gets: run it, ask first, or refuse. Use ask or deny for sending, deleting, publishing and payments. A deny beats an allow.",
    args: PolicyArgs,
    run: (a) =>
      Effect.gen(function* () {
        const policies = yield* Policies;
        switch (a.action) {
          case "list": {
            const all = yield* policies.list;
            return all.length === 0 ? "No policies." : all.map(describePolicy).join("\n");
          }
          case "add": {
            if (a.decision === undefined) {
              return yield* new ToolError({ reason: "add needs a decision" });
            }
            const made = yield* policies.add(a.match ?? "", a.decision);
            return `Policy #${made.id}: ${made.decision} ${made.match}.`;
          }
          case "remove": {
            if (a.id === undefined) return yield* new ToolError({ reason: "remove needs an id" });
            return (yield* policies.remove(a.id))
              ? `Removed policy #${a.id}.`
              : `No policy #${a.id}.`;
          }
        }
      }),
  }),
];

/**
 * Executor's own tools, behind one handler. Programs see each as `tools.executor.<tool>`, listed
 * by `executorSpecs`, and every one reaches this handler as `{ tool, input }`.
 */
export const executorTool = defineTool({
  name: "executor",
  description: "Run one of Executor's tools, once the policies allow it.",
  args: ExecutorArgs,
  run: (a, place) =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const call = a.input;
      const target = policyTarget(a.tool, call);
      const decision = yield* (yield* Policies).decide(target);
      if (decision === "deny") {
        return yield* new ToolError({ reason: `a policy denies ${target}` });
      }
      const out = yield* executor.call(a.tool, call);
      const paused = pausedExecution(out);
      if (!paused) return clipToolOutput(out);
      if (decision === "allow") {
        const resumed = yield* executor.call("resume", {
          executionId: paused.executionId,
          action: "accept",
        });
        return clipToolOutput(resumed);
      }
      yield* (yield* Approvals).add(paused.executionId, paused.summary, target, place ?? "");
      return "Waiting for the user's approval. They have been shown Approve, Always allow and Deny buttons.";
    }),
});

const signatureOnlyStringProperty = (description: string) => ({ type: "string", description });

export const executorSpecs: ReadonlyArray<{
  readonly tool: (typeof ExecutorArgs.Type)["tool"];
  readonly description: string;
  readonly input: object;
}> = [
  {
    tool: "skills",
    description: "Read how to use the user's connected apps. Start here.",
    input: { type: "object", properties: {} },
  },
  {
    tool: "search",
    description: "Find app tools by what they do.",
    input: {
      type: "object",
      properties: { query: signatureOnlyStringProperty("Such as gmail send.") },
      required: ["query"],
    },
  },
  {
    tool: "describe",
    description: "An app tool's full signature.",
    input: {
      type: "object",
      properties: { path: signatureOnlyStringProperty("Such as tools.gmail.send.") },
      required: ["path"],
    },
  },
  {
    tool: "call",
    description: "Run app tools by path.",
    input: {
      type: "object",
      properties: {
        calls: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: signatureOnlyStringProperty("From search."),
              input: { type: "object", additionalProperties: true },
            },
            required: ["path", "input"],
          },
        },
      },
      required: ["calls"],
    },
  },
  {
    tool: "execute",
    description: "Run a JavaScript program over the app tools, inside Executor.",
    input: {
      type: "object",
      properties: { code: signatureOnlyStringProperty("The program.") },
      required: ["code"],
    },
  },
];
