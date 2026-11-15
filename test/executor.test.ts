import { expect, test } from "vite-plus/test";
import { parseRpcBody } from "../src/executor.ts";

test("an MCP reply is read as plain JSON or as the last event of a stream", () => {
  expect(parseRpcBody('{"result":{"a":1}}')).toEqual({ result: { a: 1 } });
  const stream =
    'event: message\ndata: {"result":1}\n\nevent: message\ndata: {"result":{"content":[]}}\n\n';
  expect(parseRpcBody(stream)).toEqual({ result: { content: [] } });
});
