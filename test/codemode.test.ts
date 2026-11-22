import { validateToolArguments, type Tool } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { catalogText, runProgram, type Call } from "../src/codemode.ts";
import { ToolError } from "../src/errors.ts";
import { agentTools, ZOOM_DESCRIPTION } from "../src/tools.ts";

/** A fake handler set that records each call and answers with its name and arguments. */
const recorder = () => {
  const calls: Array<{ name: string; args: unknown }> = [];
  const call: Call = (name, args) => {
    calls.push({ name, args });
    return name === "web_fetch"
      ? Effect.fail(new ToolError({ reason: "403 from the site" }))
      : Effect.succeed(`${name}:${JSON.stringify(args)}`);
  };
  return { calls, call };
};

const run = (list: ReadonlyArray<string> | undefined, call: Call, code: string) =>
  Effect.runPromise(runProgram(list, call, code));

test("a program calls tools by path and reaches the handlers by name", async () => {
  const { calls, call } = recorder();
  const out = await run(
    undefined,
    call,
    `const [a, b] = await Promise.all([
       tools.memory.zoom({ id: 4, n: 2 }),
       tools.automations.cancel({ id: 7 }),
     ])
     console.log("both done")
     return a + " | " + b`,
  );
  expect(out).toBe('zoom:{"id":4,"n":2} | automation_cancel:{"id":7}\n\nLogs:\nboth done');
  expect(calls.map((c) => c.name).sort()).toEqual(["automation_cancel", "zoom"]);
});

test("a failed tool throws what the handler said, and bad input never reaches the handler", async () => {
  const { calls, call } = recorder();
  expect(
    await run(
      undefined,
      call,
      `try { await tools.web.fetch({ url: "https://x.test" }) } catch (e) { return "caught: " + e.message }`,
    ),
  ).toBe("caught: 403 from the site");

  const bad = await run(undefined, call, `return await tools.memory.zoom({ id: -1, n: 2 })`);
  expect(bad).toMatch(/^Error \(InvalidToolInput/);
  expect(calls.map((c) => c.name)).toEqual(["web_fetch"]);
});

test("a role's tools list hides the rest, by path or by namespace", async () => {
  const { calls, call } = recorder();
  const denied = await run(
    ["memory", "executor.call"],
    call,
    `return await tools.web.search({ query: "x" })`,
  );
  expect(denied).toMatch(/^Error \(UnknownTool/);
  expect(calls).toEqual([]);

  const out = await run(
    ["memory", "executor.call"],
    call,
    `return [await tools.memory.date({ id: 3 }), await tools.executor.call({ calls: [] })].join(" | ")`,
  );
  expect(out).toBe('date:{"id":3} | executor:{"tool":"call","input":{"calls":[]}}');

  const lines = catalogText(["memory.zoom", "executor.call"]).split("\n");
  expect(lines).toEqual([
    "- tools.executor.call({ calls: Array<{ path: string, input: {} }> }): Promise<string>: Run app tools by path.",
    `- tools.memory.zoom({ id: number, n: number }): Promise<string>: ${ZOOM_DESCRIPTION}`,
  ]);
});

test("the model gets send_to_user and execute only, checked against their schemas", () => {
  expect(agentTools.map((t) => t.name)).toEqual(["send_to_user", "execute"]);
  const check = (name: string, args: object) => () =>
    validateToolArguments(
      agentTools.find((t) => t.name === name) as Tool,
      {
        type: "toolCall",
        id: "1",
        name,
        arguments: args,
      } as never,
    );
  expect(check("send_to_user", { messages: ["hey", "one sec"] })()).toBeTruthy();
  expect(check("send_to_user", { messages: [] })).toThrow();
  expect(check("send_to_user", { messages: Array(9).fill("x") })).toThrow();
  expect(check("execute", { code: "return 1" })()).toEqual({ code: "return 1" });
  expect(check("execute", {})).toThrow();
});
