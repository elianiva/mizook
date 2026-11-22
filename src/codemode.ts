import { CodeMode, Tool, toolError } from "@opencode/codemode";
import { clipToolOutput } from "@mizook/memory";
import { Effect, Schema } from "effect";
import { executorSpecs, toolSpecs } from "./tools.ts";

/** Runs a handler by name. A failure is what the program catches as a thrown error. */
export type Call = (
  name: string,
  args: unknown,
) => Effect.Effect<string, { readonly message: string }>;

/** A role's tools list lets a path through by the path itself or its namespace; no list lets everything through. */
export const allows = (list: ReadonlyArray<string> | undefined, path: string): boolean =>
  list === undefined || list.includes(path) || list.includes(path.slice(0, path.indexOf(".")));

/** Every path a tools list can name. */
export const toolPaths: ReadonlyArray<string> = [
  ...toolSpecs.map((spec) => spec.path),
  ...executorSpecs.map((spec) => `executor.${spec.tool}`),
];

const tools = (list: ReadonlyArray<string> | undefined, call: Call) => {
  const byNamespace: Record<string, Record<string, Tool.Tool>> = {};
  const add = (path: string, description: string, input: Tool.SchemaType, run: Call) => {
    if (!allows(list, path)) return;
    const [namespace = "", name = ""] = path.split(".");
    (byNamespace[namespace] ??= {})[name] = Tool.make({
      description,
      input,
      output: Schema.String,
      execute: (args) => run(path, args).pipe(Effect.mapError((error) => toolError(error.message))),
    });
  };
  for (const spec of toolSpecs) {
    add(spec.path, spec.description, spec.args, (_, args) => call(spec.name, args));
  }
  for (const spec of executorSpecs) {
    add(`executor.${spec.tool}`, spec.description, spec.input, (_, input) =>
      call("executor", { tool: spec.tool, input }),
    );
  }
  return byNamespace;
};

const LIMITS = { timeoutMs: 170_000, maxToolCalls: 40, maxOutputBytes: 48_000 } as const;

/** The tools a role may use, one line each with its doc comments dropped, for the system prompt. */
export const catalogText = (list: ReadonlyArray<string> | undefined): string =>
  CodeMode.make({ tools: tools(list, () => Effect.die("catalog only")) })
    .catalog.map(
      (tool) =>
        `- ${tool.signature
          .replace(/\/\*\*[\s\S]*?\*\//g, "")
          .replace(/\s+/g, " ")
          .replace(/, }/g, " }")}: ${tool.description}`,
    )
    .join("\n");

/** What the model reads back from a program: its value, then its logs, or the error that stopped it. */
export const formatResult = (result: CodeMode.Result): string => {
  const logs = result.logs?.length ? `\n\nLogs:\n${result.logs.join("\n")}` : "";
  if (!result.ok) {
    const { kind, message, location, suggestions } = result.error;
    const at = location ? ` at line ${location.line}` : "";
    const hints = suggestions?.length ? `\n${suggestions.join("\n")}` : "";
    return clipToolOutput(`Error (${kind}${at}): ${message}${hints}${logs}`);
  }
  const value =
    result.value === null
      ? "Done, nothing returned."
      : typeof result.value === "string"
        ? result.value
        : JSON.stringify(result.value, null, 2);
  return clipToolOutput(`${value}${logs}`);
};

/** Runs one program over the tools a role may use. Never fails: a broken program is an answer too. */
export const runProgram = (
  list: ReadonlyArray<string> | undefined,
  call: Call,
  code: string,
): Effect.Effect<string> =>
  CodeMode.make({ tools: tools(list, call), limits: LIMITS })
    .execute(code)
    .pipe(Effect.map(formatResult));
