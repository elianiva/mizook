import { createParser, isElementNode, type LibraryJSONSchema } from "@openuidev/lang-core";
import { Option, Schema } from "effect";
import type { Token } from "marked";
import { marked, safeHref } from "./markdown.ts";

const Text = Schema.String.check(Schema.isMinLength(1));
const listOf = <S extends Schema.Top>(item: S, max: number) =>
  Schema.Array(item).check(Schema.isMinLength(1), Schema.isMaxLength(max));

// Key order is argument order: `Bar("Mon", 3.2)` fills label, then value.

const Metric = Schema.Struct({
  label: Text,
  value: Text,
  delta: Schema.optionalKey(Schema.String),
  trend: Schema.optionalKey(Schema.Literals(["up", "down", "flat"])),
  /** Whether the change is good news; spend going down is. Unset is neutral. */
  good: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "Metric" });
const Metrics = Schema.Struct({ items: listOf(Metric, 8) }).annotate({ identifier: "Metrics" });

const Bar = Schema.Struct({ label: Text, value: Schema.Finite }).annotate({ identifier: "Bar" });
const Bars = Schema.Struct({
  items: listOf(Bar, 24),
  title: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Bars" });

const Step = Schema.Struct({
  text: Text,
  state: Schema.optionalKey(Schema.Literals(["done", "current", "todo"])),
}).annotate({ identifier: "Step" });
const Steps = Schema.Struct({
  items: listOf(Step, 20),
  title: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Steps" });

const Source = Schema.Struct({ title: Text, url: Text }).annotate({ identifier: "Source" });
const Sources = Schema.Struct({ items: listOf(Source, 12) }).annotate({ identifier: "Sources" });

const Callout = Schema.Struct({
  body: Text,
  tone: Schema.optionalKey(Schema.Literals(["info", "ok", "warn", "danger"])),
  title: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Callout" });

const Choices = Schema.Struct({
  items: listOf(Text, 6),
  prompt: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Choices" });

/** The catalog: the only components an answer can draw. */
const catalog = { Metrics, Bars, Steps, Sources, Callout, Choices } as const;
type Catalog = typeof catalog;

export type Block = {
  readonly [K in keyof Catalog]: { readonly type: K; readonly props: Catalog[K]["Type"] };
}[keyof Catalog];

/** Several blocks in one program. Only the parser sees it; it renders as its children. */
const Stack = Schema.Struct({
  children: Schema.Array(Schema.Union(Object.values(catalog))),
}).annotate({ identifier: "Stack" });

const library = ((): LibraryJSONSchema => {
  const document = Schema.toJsonSchemaDocument(Stack);
  const $defs = document.definitions as NonNullable<LibraryJSONSchema["$defs"]>;
  return {
    $defs,
    properties: Object.fromEntries(
      Object.keys($defs).map((name) => [name, { $ref: `#/$defs/${name}` }]),
    ),
  };
})();

const parser = createParser(library, "Stack");

/** An element's props with every nested element replaced by its own props. */
const plain = (value: unknown): unknown =>
  isElementNode(value)
    ? plain(value.props)
    : Array.isArray(value)
      ? value.map(plain)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, plain(inner)]))
        : value;

const isCatalogName = (name: string): name is keyof Catalog => Object.hasOwn(catalog, name);

const blockOf = (node: unknown): Option.Option<Block> => {
  if (!isElementNode(node) || !isCatalogName(node.typeName)) return Option.none();
  // A press sends the choice's text, so a choice must be whole before it shows.
  if (node.typeName === "Choices" && node.partial) return Option.none();
  const type = node.typeName;
  return Schema.decodeUnknownOption(catalog[type] as Schema.Codec<Block["props"]>)(
    plain(node.props),
  ).pipe(
    Option.map((props) => ({ type, props }) as Block),
    // A source must be a link the Markdown renderer would also allow.
    Option.filter(
      (block) =>
        block.type !== "Sources" ||
        block.props.items.every((item) => safeHref(item.url, false) !== undefined),
    ),
  );
};

const blocksOf = (program: string): ReadonlyArray<Block> => {
  const root = parser.parse(program).root;
  const nodes = isElementNode(root) && root.typeName === "Stack" ? root.props["children"] : [root];
  return Array.isArray(nodes) ? nodes.flatMap((node) => Option.toArray(blockOf(node))) : [];
};

export type Segment =
  | { readonly kind: "markdown"; readonly html: string }
  | { readonly kind: "ui"; readonly blocks: ReadonlyArray<Block> }
  | { readonly kind: "pending" };

const isClosedFence = (raw: string): boolean => /\n\s*(```|~~~)$/.test(raw.trimEnd());

/**
 * Splits an answer into Markdown runs and OpenUI Lang programs. An open fence,
 * as while a reply streams in, shows the blocks that already parse, or a
 * placeholder before the first one does. A closed fence that draws nothing
 * renders as the code block it is.
 */
export const segmentsOf = (text: string): ReadonlyArray<Segment> => {
  const segments: Array<Segment> = [];
  let run: Array<Token> = [];
  const flush = () => {
    if (run.length > 0) segments.push({ kind: "markdown", html: marked.parser(run) });
    run = [];
  };
  for (const token of marked.lexer(text)) {
    if (token.type !== "code" || token.lang !== "openui-lang") {
      run.push(token);
      continue;
    }
    const blocks = blocksOf(token.text);
    if (blocks.length > 0) {
      flush();
      segments.push({ kind: "ui", blocks });
    } else if (!isClosedFence(token.raw)) {
      flush();
      segments.push({ kind: "pending" });
    } else {
      run.push(token);
    }
  }
  flush();
  return segments;
};
