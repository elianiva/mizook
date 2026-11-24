import { CodeMode, Tool, toolError } from "@opencode/codemode";
import { clipToolOutput } from "@mizook/memory";
import { Effect, Schema } from "effect";
import { executorSpecs } from "./policy-tools.ts";
import { programTools, toolPaths } from "./tools.ts";

export { toolPaths };

export type Call = (
  name: string,
  args: unknown,
) => Effect.Effect<string, { readonly message: string }>;

const namespaceOf = (path: string): string => path.slice(0, path.indexOf("."));

export const allows = (list: ReadonlyArray<string> | undefined, path: string): boolean => {
  const everyToolAllowed = list === undefined;
  return everyToolAllowed || list.includes(path) || list.includes(namespaceOf(path));
};

const toolsByNamespace = (list: ReadonlyArray<string> | undefined, call: Call) => {
  const byNamespace: Record<string, Record<string, Tool.Tool>> = {};
  const add = (path: string, description: string, input: Tool.SchemaType, run: Call) => {
    if (!allows(list, path)) return;
    const [namespace = "", name = ""] = path.split(".");
    (byNamespace[namespace] ??= {})[name] = Tool.make({
      description,
      input,
      output: Schema.String,
      execute: (args) =>
        run(path, args).pipe(
          Effect.mapError((error) =>
            toolError(error.message === "" ? `${path} failed without saying why` : error.message),
          ),
        ),
    });
  };
  for (const tool of programTools) {
    if (tool.path === undefined) continue;
    add(tool.path, tool.description, tool.args, (_, args) => call(tool.name, args));
  }
  for (const spec of executorSpecs) {
    add(`executor.${spec.tool}`, spec.description, spec.input, (_, input) =>
      call("executor", { tool: spec.tool, input }),
    );
  }
  return byNamespace;
};

const PROGRAM_LIMITS = { timeoutMs: 170_000, maxToolCalls: 40, maxOutputBytes: 48_000 } as const;

const oneLineSignatureWithoutDocComments = (signature: string): string =>
  signature
    .replace(/\/\*\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/, }/g, " }");

export const catalogText = (list: ReadonlyArray<string> | undefined): string =>
  CodeMode.make({ tools: toolsByNamespace(list, () => Effect.die("catalog only")) })
    .catalog.map(
      (tool) => `- ${oneLineSignatureWithoutDocComments(tool.signature)}: ${tool.description}`,
    )
    .join("\n");

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

export const runProgram = (
  list: ReadonlyArray<string> | undefined,
  call: Call,
  code: string,
): Effect.Effect<string> =>
  CodeMode.make({ tools: toolsByNamespace(list, call), limits: PROGRAM_LIMITS })
    .execute(code)
    .pipe(Effect.map(formatResult));
