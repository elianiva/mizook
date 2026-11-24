import { validateToolArguments, type Tool } from "@earendil-works/pi-ai";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { allows, catalogText, runProgram, toolPaths, type Call } from "../src/codemode.ts";
import { ToolError } from "../src/errors.ts";
import { AutomationIdArgs } from "../src/automation-tools.ts";
import { DateArgs, ZOOM_DESCRIPTION, ZoomArgs } from "../src/memory-tools.ts";
import { agentTools } from "../src/tools.ts";
import { property } from "./property.ts";

const recorder = (failure: string) => {
  const calls: Array<{ name: string; args: unknown }> = [];
  const call: Call = (name, args) => {
    calls.push({ name, args });
    return name === "web_fetch"
      ? Effect.fail(new ToolError({ reason: failure }))
      : Effect.succeed(`${name}:${JSON.stringify(args)}`);
  };
  return { calls, call };
};

const text = Arbitrary.schema(Schema.String).pipe(
  Arbitrary.filter((value) => !/\p{Cs}/u.test(value)),
);

const lineOf = (schema: Schema.String) =>
  Arbitrary.schema(schema).pipe(
    Arbitrary.filter((value) => !/[\p{Cs}\n\r\u2028\u2029]/u.test(value)),
  );

const line = lineOf(Schema.String);

const NAMESPACES = [...new Set(toolPaths.map((path) => path.slice(0, path.indexOf("."))))];

const roleList = Arbitrary.array(
  Arbitrary.schema(Schema.Literals([...toolPaths, ...NAMESPACES] as [string, ...string[]])),
  { maxLength: 6 },
);

const referenceAllows = (list: ReadonlyArray<string> | undefined, path: string) =>
  list === undefined || list.some((entry) => entry === path || path.startsWith(`${entry}.`));

property(
  "a program calls tools by path, reaches the handlers by name with its input, and returns their answers with its logs",
  Arbitrary.all({
    zoom: Arbitrary.schema(ZoomArgs),
    cancel: Arbitrary.schema(AutomationIdArgs),
    log: line,
  }),
  ({ zoom, cancel, log }) =>
    Effect.gen(function* () {
      const { calls, call } = recorder("unused");
      const out = yield* runProgram(
        undefined,
        call,
        `const [a, b] = await Promise.all([
           tools.memory.zoom(${JSON.stringify(zoom)}),
           tools.automations.cancel(${JSON.stringify(cancel)}),
         ])
         console.log(${JSON.stringify(log)})
         return a + " | " + b`,
      );
      expect(out).toBe(
        `zoom:${JSON.stringify(zoom)} | automation_cancel:${JSON.stringify(cancel)}\n\nLogs:\n${log}`,
      );
      expect(calls.map((c) => c.name).sort()).toEqual(["automation_cancel", "zoom"]);
    }),
  { runs: 30 },
);

property(
  "a failed tool throws what the handler said, or that it failed without saying why",
  lineOf(Schema.String),
  (reason) =>
    Effect.gen(function* () {
      const { calls, call } = recorder(reason);
      const out = yield* runProgram(
        undefined,
        call,
        `try { await tools.web.fetch({ url: "https://x.test" }) } catch (e) { return "caught: " + e.message }`,
      );
      expect(out).toBe(`caught: ${reason === "" ? "web.fetch failed without saying why" : reason}`);
      expect(calls.map((c) => c.name)).toEqual(["web_fetch"]);
    }),
  { runs: 30 },
);

property(
  "input that breaks a tool's schema is refused before it reaches the handler",
  Arbitrary.all({
    id: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ minimum: -1_000_000, maximum: 1_000 })),
    ),
    n: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: -1_000, maximum: 1_000 }))),
  }).pipe(Arbitrary.filter(({ id, n }) => id < 0 || n < 1)),
  ({ id, n }) =>
    Effect.gen(function* () {
      const { calls, call } = recorder("unused");
      const out = yield* runProgram(
        undefined,
        call,
        `return await tools.memory.zoom({ id: ${id}, n: ${n} })`,
      );
      expect(out).toMatch(/^Error \(InvalidToolInput/);
      expect(calls).toEqual([]);
    }),
  { runs: 30 },
);

property(
  "a role's tools list allows a path when it names the path or its namespace, and the catalog lists exactly those, sorted",
  Arbitrary.all({ list: roleList, everything: Arbitrary.schema(Schema.Boolean) }),
  ({ list, everything }) => {
    const given = everything ? undefined : list;
    const expected = toolPaths.filter((path) => referenceAllows(given, path)).sort();
    for (const path of toolPaths) expect(allows(given, path)).toBe(referenceAllows(given, path));
    const catalog = catalogText(given);
    const lines = catalog === "" ? [] : catalog.split("\n");
    expect(lines.map((l) => /^- tools\.([\w.]+)\(/.exec(l)?.[1])).toEqual(expected);
    if (expected.includes("memory.zoom")) {
      expect(lines).toContain(
        `- tools.memory.zoom({ id: number, n: number }): Promise<string>: ${ZOOM_DESCRIPTION}`,
      );
    }
    if (expected.includes("executor.call")) {
      expect(lines).toContain(
        "- tools.executor.call({ calls: Array<{ path: string, input: {} }> }): Promise<string>: Run app tools by path.",
      );
    }
  },
);

property(
  "a program calling a tool its role hides gets UnknownTool and no handler runs, while an allowed one answers",
  Arbitrary.all({
    list: roleList.pipe(Arbitrary.filter((list) => !referenceAllows(list, "web.search"))),
    date: Arbitrary.schema(DateArgs),
  }),
  ({ list, date }) =>
    Effect.gen(function* () {
      const { calls, call } = recorder("unused");
      const denied = yield* runProgram(list, call, `return await tools.web.search({ query: "x" })`);
      expect(denied).toMatch(/^Error \(UnknownTool/);
      expect(calls).toEqual([]);
      const withDate = [...list, "memory.date", "executor"];
      const out = yield* runProgram(
        withDate,
        call,
        `return [await tools.memory.date(${JSON.stringify(date)}), await tools.executor.call({ calls: [] })].join(" | ")`,
      );
      expect(out).toBe(
        `date:${JSON.stringify(date)} | executor:{"tool":"call","input":{"calls":[]}}`,
      );
    }),
  { runs: 30 },
);

const validate = (name: string, args: object) =>
  validateToolArguments(
    agentTools.find((t) => t.name === name) as Tool,
    { type: "toolCall", id: "1", name, arguments: args } as never,
  );

property(
  "the model gets only send_to_user and execute, and send_to_user takes one to eight messages",
  Arbitrary.array(text, { maxLength: 12 }),
  (messages) => {
    expect(agentTools.map((t) => t.name)).toEqual(["send_to_user", "execute"]);
    if (messages.length >= 1 && messages.length <= 8) {
      expect(validate("send_to_user", { messages })).toEqual({ messages });
    } else {
      expect(() => validate("send_to_user", { messages })).toThrow();
    }
  },
);

property("execute takes any code string and refuses a call without one", text, (code) => {
  expect(validate("execute", { code })).toEqual({ code });
  expect(() => validate("execute", {})).toThrow();
});
