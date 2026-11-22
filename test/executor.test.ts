import { Arbitrary, Schema } from "effect";
import { expect } from "vite-plus/test";
import { parseRpcBody, pausedExecution } from "../src/executor.ts";
import { property } from "./property.ts";

const json = Arbitrary.schema(Schema.Json);

const viaJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

const padding = Arbitrary.schema(
  Schema.String.check(Schema.isPattern(/^[ \n\t]*$/), Schema.isMaxLength(4)),
);

const text = Arbitrary.schema(Schema.String.check(Schema.isMaxLength(2_000)));

const record = Arbitrary.schema(Schema.Record(Schema.String, Schema.Json));

const hasStringExecutionId = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as Record<string, unknown>)["executionId"] === "string";

property(
  "a plain JSON reply parses to the value that was sent, ignoring surrounding whitespace",
  Arbitrary.all({ value: json, before: padding, after: padding }),
  ({ value, before, after }) => {
    expect(parseRpcBody(`${before}${JSON.stringify(value)}${after}`)).toEqual(viaJson(value));
  },
  { size: 20 },
);

property(
  "an event stream reply parses to the data of its last event, whatever came before",
  Arbitrary.all({
    values: Arbitrary.array(json, { minLength: 1, maxLength: 6 }),
    leadWithData: Arbitrary.schema(Schema.Boolean),
    space: Arbitrary.schema(Schema.Literals(["", " "])),
  }),
  ({ values, leadWithData, space }) => {
    const stream = values
      .map(
        (value) =>
          `${leadWithData ? "" : "event: message\n"}data:${space}${JSON.stringify(value)}\n\n`,
      )
      .join("");
    expect(parseRpcBody(stream)).toEqual(viaJson(values.at(-1)));
  },
  { size: 20 },
);

property(
  "a result with a string execution id is paused, keeps that id, and its summary is the first 1500 characters",
  Arbitrary.all({
    executionId: Arbitrary.schema(Schema.String),
    message: Arbitrary.all({
      unit: Arbitrary.schema(Schema.Literals(["a", "é", "😀", "\n", '"'])),
      count: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_600 }))),
    }).pipe(Arbitrary.map(({ unit, count }) => unit.repeat(count))),
    extra: record,
  }),
  ({ executionId, message, extra }) => {
    const body = JSON.stringify({
      ...extra,
      status: "paused",
      interaction: { message },
      executionId,
    });
    const paused = pausedExecution(body);
    expect(paused?.executionId).toBe(executionId);
    expect(paused?.summary).toBe(body.substring(0, 1_500));
    expect(paused?.summary.length).toBe(Math.min(body.length, 1_500));
  },
  { size: 60 },
);

property(
  "any JSON value without a string execution id is not a paused result",
  Arbitrary.all({ value: json, executionId: json }).pipe(
    Arbitrary.map(({ value, executionId }) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof executionId !== "string"
        ? Object.assign({}, value, { executionId })
        : value,
    ),
    Arbitrary.filter((value) => !hasStringExecutionId(value)),
  ),
  (value) => {
    expect(pausedExecution(JSON.stringify(value))).toBeUndefined();
  },
  { size: 20 },
);

property(
  "text that is not JSON is never a paused result",
  text.pipe(
    Arbitrary.filter((candidate) => {
      try {
        JSON.parse(candidate);
        return false;
      } catch {
        return true;
      }
    }),
  ),
  (candidate) => {
    expect(pausedExecution(candidate)).toBeUndefined();
  },
);
