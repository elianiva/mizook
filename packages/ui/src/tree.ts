import { tree } from "@ui-sdk/core/tree";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

/** A node of a flat list. `parent` is another node's value, or empty at the root. */
export const Node = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
  parent: Schema.String,
});
export type Node = typeof Node.Type;

export const State = Schema.Struct({
  key: Schema.String,
  nodes: Schema.Array(Node),
  /** The selected node, or null. Unused while `checkable`. */
  value: Schema.NullOr(Schema.String),
  expanded: Schema.Array(Schema.String),
  checked: Schema.Array(Schema.String),
  checkable: Schema.Boolean,
});
export type State = typeof State.Type;

export const init = (state: {
  key: string;
  nodes: ReadonlyArray<Node>;
  value?: string;
  expanded?: ReadonlyArray<string>;
  checked?: ReadonlyArray<string>;
  checkable?: boolean;
}): State => ({
  key: state.key,
  nodes: state.nodes,
  value: state.value ?? null,
  expanded: state.expanded ?? [],
  checked: state.checked ?? [],
  checkable: state.checkable ?? false,
});

/** The nodes directly under `parent` (empty for the roots). */
export const childrenOf = (state: State, parent: string): ReadonlyArray<Node> =>
  state.nodes.filter((node) => node.parent === parent);

export const isBranch = (state: State, value: string) =>
  state.nodes.some((node) => node.parent === value);

/** The props `item` takes for a node: its parent and whether it has children. */
export const itemProps = (state: State, node: Node) => ({
  value: node.value,
  label: node.label,
  branch: isBranch(state, node.value),
  ...(node.parent === "" ? {} : { parent: node.parent }),
});

type TreeItem = { value: string; label: string; children?: Array<TreeItem> };

const nest = (state: State, parent: string): Array<TreeItem> =>
  childrenOf(state, parent).map((node) => {
    const children = nest(state, node.value);
    return children.length === 0
      ? { value: node.value, label: node.label }
      : { value: node.value, label: node.label, children };
  });

const strings = Schema.decodeUnknownSync(Schema.Array(Schema.String));

type Slot = "root" | "item" | "label" | "indicator" | "checkbox" | "group";

export const component = defineComponent<State, Slot>({
  name: "tree",
  primitive: primitiveOf(tree),
  state: State,
  key: (state) => state.key,
  options: (state) => ({
    items: nest(state, ""),
    mode: state.checkable ? "none" : "single",
    value: state.checkable ? null : state.value,
    expanded: [...state.expanded],
    checkable: state.checkable,
    checked: [...state.checked],
    checkStrategy: "trunk",
  }),
  controlled: ["value", "expanded", "checked"],
  callbacks: {
    onValueChange: "value",
    onExpandedChange: "expanded",
    onCheckedChange: "checked",
  },
  fold: (state, snapshot) => ({
    ...state,
    value: typeof snapshot["value"] === "string" ? snapshot["value"] : null,
    expanded: strings(snapshot["expanded"] ?? state.expanded),
    checked: strings(snapshot["checked"] ?? state.checked),
  }),
  tags: {
    root: "ul",
    item: "li",
    label: "div",
    indicator: "span",
    checkbox: "span",
    group: "ul",
  },
  bound: ["root", "item", "label", "indicator", "checkbox", "group"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
