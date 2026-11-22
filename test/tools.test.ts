import { validateToolArguments, type Tool } from "@earendil-works/pi-ai";
import { expect, test } from "vite-plus/test";
import { toolSpecs } from "../src/tools.ts";

const check = (name: string, args: object) => {
  const tool = toolSpecs.find((t) => t.name === name) as Tool;
  return () =>
    validateToolArguments(tool, { type: "toolCall", id: "1", name, arguments: args } as never);
};

test("the tool schemas, derived from Effect Schema, accept good arguments and reject bad ones", () => {
  expect(check("zoom", { id: 0, n: 4 })()).toEqual({ id: 0, n: 4 });
  expect(check("zoom", { id: -1, n: 4 })).toThrow();
  expect(check("zoom", { id: 0 })).toThrow();
  expect(
    check("automation_create", { trigger: "cron", prompt: "x", cron: "0 9 * * *" })(),
  ).toBeTruthy();
  expect(
    check("automation_create", { trigger: "webhook", action: "post", text: "hi" })(),
  ).toBeTruthy();
  expect(check("automation_create", { trigger: "sometimes", prompt: "x" })).toThrow();
  expect(check("automation_create", { trigger: "watch", prompt: "x", every_minutes: 1 })).toThrow();
  expect(check("automation_create", { trigger: "once", action: "email" })).toThrow();
  expect(check("automation_list", {})()).toEqual({});
  expect(check("send_to_user", { messages: ["hey", "one sec"] })()).toBeTruthy();
  expect(check("send_to_user", { messages: [] })).toThrow();
  expect(check("send_to_user", { messages: Array(9).fill("x") })).toThrow();
});
