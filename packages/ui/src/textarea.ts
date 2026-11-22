import { textarea } from "@ui-sdk/core/input";
import { Schema } from "effect";
import type { Attribute, Html, HtmlBuilder, TextareaAttribute } from "foldkit/html";
import { defineComponent, makeParts, makeUpdate, Message, type PartsConfig } from "./core.ts";
import type { PartProps } from "./internal/render.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({ key: Schema.String, value: Schema.String });
export type State = typeof State.Type;

export const init = (state: { key: string; value?: string }): State => ({
  key: state.key,
  value: state.value ?? "",
});

type Slot = "root";

// `h.textarea` takes no children and no InnerHTML, so the core part is not built here. The
// element is made in `parts` from the part's attributes, and nothing binds: growing with the text
// is CSS (`field-sizing: content`), and the text is Foldkit's, through `typed`.
export const component = defineComponent<State, Slot>({
  name: "textarea",
  primitive: primitiveOf(textarea),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ value: state.value }),
  controlled: ["value"],
  callbacks: { onValueChange: "value" },
  fold: (state, snapshot) => ({
    ...state,
    value: typeof snapshot["value"] === "string" ? snapshot["value"] : "",
  }),
  typed: (state, text) => ({ ...state, value: text }),
  text: "root",
  tags: { root: "input" },
  bound: [],
});

const base = makeParts(component);

export const parts = <AppMessage>(
  state: State,
  h: HtmlBuilder<AppMessage>,
  config: PartsConfig<AppMessage>,
) => {
  const core = base(state, h, config);
  return {
    root: (props: PartProps = {}, attributes: ReadonlyArray<Attribute<AppMessage>> = []): Html =>
      h.textarea(
        [
          ...core.attributes("root", props),
          h.Key(`textarea:${state.key}`),
          h.Value(state.value),
          h.OnInput((value: string) =>
            config.toMessage(
              Message.TypedUiText({ component: component.name, key: state.key, value }),
            ),
          ),
          ...attributes,
        ].filter(
          (attribute): attribute is TextareaAttribute<AppMessage> => attribute._tag !== "InnerHTML",
        ),
      ),
    attributes: core.attributes,
  };
};

export const update = makeUpdate(component);
