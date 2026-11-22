import { fileInput } from "@ui-sdk/core/file-input";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

export const FileSummary = Schema.Struct({ name: Schema.String, size: Schema.Finite });

// `File` objects are not data, so they stay in the instance. The Model keeps what the page
// shows: name and size. Reading the bytes goes through the instance, not the Model.
export const State = Schema.Struct({
  key: Schema.String,
  multiple: Schema.Boolean,
  files: Schema.Array(FileSummary),
});
export type State = typeof State.Type;

export const init = (state: { key: string; multiple?: boolean }): State => ({
  key: state.key,
  multiple: state.multiple ?? true,
  files: [],
});

const summarize = (value: unknown): State["files"] =>
  Array.isArray(value)
    ? value.flatMap((file) => (file instanceof File ? [{ name: file.name, size: file.size }] : []))
    : [];

type Slot = "root" | "input" | "trigger" | "dropzone";

export const component = defineComponent<State, Slot>({
  name: "file-input",
  primitive: primitiveOf(fileInput),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ multiple: state.multiple }),
  controlled: [],
  callbacks: {},
  completions: { onValueChange: "files" },
  fold: (state, snapshot) => ({ ...state, files: summarize(snapshot["files"]) }),
  tags: { root: "div", input: "input", trigger: "button", dropzone: "div" },
  bound: ["root", "input", "trigger", "dropzone"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
