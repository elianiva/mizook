import { avatar } from "@ui-sdk/core/avatar";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({ key: Schema.String });
export type State = typeof State.Type;

export const init = (state: { key: string }): State => ({ key: state.key });

type Slot = "root" | "image" | "fallback";

export const component = defineComponent<State, Slot>({
  name: "avatar",
  primitive: primitiveOf(avatar),
  state: State,
  key: (state) => state.key,
  options: () => ({}),
  controlled: [],
  callbacks: {},
  fold: (state) => state,
  tags: { root: "span", image: "img", fallback: "span" },
  bound: ["root", "image", "fallback"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
