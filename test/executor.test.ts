import { expect, test } from "vite-plus/test";
import { parseRpcBody } from "../src/executor.ts";

test("an MCP reply is read as plain JSON or as the last event of a stream", () => {
  expect(parseRpcBody('{"result":{"a":1}}')).toEqual({ result: { a: 1 } });
  const stream =
    'event: message\ndata: {"result":1}\n\nevent: message\ndata: {"result":{"content":[]}}\n\n';
  expect(parseRpcBody(stream)).toEqual({ result: { content: [] } });
});

test("a paused result is recognised by its execution id; a finished or plain one is not", async () => {
  const { pausedExecution } = await import("../src/executor.ts");
  const paused = pausedExecution(
    JSON.stringify({
      status: "paused",
      executionId: "exec_1",
      interaction: { message: "Send mail?" },
    }),
  );
  expect(paused?.executionId).toBe("exec_1");
  expect(paused?.summary).toContain("Send mail?");
  expect(pausedExecution(JSON.stringify({ ok: true, value: 3 }))).toBeUndefined();
  expect(pausedExecution("plain text")).toBeUndefined();
});
