import { Effect, Option, Queue, Schema, Stream } from "effect";
import { Command, Mount } from "foldkit";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { attach, type Binding, type Change, isDev, type Snapshot, sync } from "./internal/bind.ts";
import { findRegistry, UiRegistry, UNBOUND_ATTRIBUTE } from "./registry.ts";
import { type Attrs, type PartProps, type Primitive, renderPhase } from "./internal/render.ts";

// ── Messages ────────────────────────────────────────────────────────────────

/** `component` + `key` say whose state a Message is about. */
export const Message = defineMessageUnion({
  /**
   * An instance accepted a change. Carries every controlled option of that
   * instance, not one pair, so applying it is idempotent and order-independent.
   * `reason` is for policy (refuse, log), never for rebuilding state.
   */
  ChangedUiState: {
    component: Schema.String,
    key: Schema.String,
    snapshot: Schema.Record(Schema.String, Schema.Unknown),
    reason: Schema.String,
  },
  /** Text typed into an input Foldkit owns. Core never sees it. */
  TypedUiText: { component: Schema.String, key: Schema.String, value: Schema.String },
  /**
   * The synchronous guard vetoed a change. The instance did not move. `update`
   * normally ignores it; log it, or show why. `snapshot` is what was asked for.
   */
  RefusedUiChange: {
    component: Schema.String,
    key: Schema.String,
    snapshot: Schema.Record(Schema.String, Schema.Unknown),
    reason: Schema.String,
  },
  CompletedUiSync: {},
});
export type Message = typeof Message.Type;

// ── Component description ───────────────────────────────────────────────────

export type Tag =
  | "div"
  | "nav"
  | "button"
  | "input"
  | "img"
  | "a"
  | "label"
  | "span"
  | "ul"
  | "li"
  | "p"
  | "h2"
  | "h3"
  | "section"
  | "header"
  | "footer"
  | "form"
  | "ol"
  | "h1"
  | "h4"
  | "fieldset"
  | "legend"
  | "output";

export type Component<State, Slot extends string> = Readonly<{
  /** `data-slot` prefix and registry name. */
  name: string;
  primitive: Primitive;
  /** Schema of the slice of Model this component owns. */
  state: Schema.Codec<State>;
  /** Stable identity. Comes from the Model, never from a counter. */
  key: (state: State) => string;
  /** Model state to ui-sdk options. Pure. */
  options: (state: State) => Readonly<Record<string, unknown>>;
  /** Option names the Model controls (ui-sdk's `controlled`). */
  controlled: ReadonlyArray<string>;
  /** ui-sdk callback option to the controlled option it asks to change. */
  callbacks: Readonly<Record<string, string>>;
  /** Slots whose part stays in the page while closed, so CSS can animate the close. */
  keepMounted?: ReadonlyArray<Slot>;
  /** Instance state keys the Model follows read-only (`moving`), folded like a snapshot. */
  mirror?: ReadonlyArray<string>;
  /** The slot whose bind takes the document scroll lock. Set it on a modal's content. */
  lockSlot?: Slot;
  /** Completion callbacks to the snapshot key they set (`onOpenChangeComplete: 'mounted'`). */
  completions?: Readonly<Record<string, string>>;
  /** Internal ui-sdk state the Model owns, patched over a fresh instance in the render phase. */
  renderState?: (state: State) => Readonly<Record<string, unknown>>;
  /**
   * Synchronous veto for policy the app knows at view time. Default: allow.
   * `reason` is ui-sdk's `details.reason`, so a guard can refuse an `escape-key` and allow a `close-press`.
   * Returning false is `details.cancel()`.
   */
  guard?: (state: State, snapshot: Snapshot, reason: string) => boolean;
  /**
   * State after a snapshot of controlled options lands. Pure and idempotent.
   * `reason` says why when a change carries one, for policy only (a `dirty` flag, a log), never to rebuild state.
   */
  fold: (state: State, snapshot: Snapshot, reason?: string) => State;
  /** State after text is typed into the `text` slot. */
  typed?: (state: State, text: string) => State;
  /** The slot whose text entry Foldkit owns: `h.Value` and `h.OnInput`, no core `input` handler. */
  text?: Slot;
  tags: Readonly<Record<Slot, Tag>>;
  /** Slots that need a live element: handlers, focus, observers. The rest stay pure. */
  bound: ReadonlyArray<Slot>;
}>;

/** Pure and global-free: the Binding the registry holds for a component. */
export const bindingOf = <State, Slot extends string>(
  component: Component<State, Slot>,
): Binding => {
  const decode = Schema.decodeUnknownSync(component.state);
  return {
    primitive: component.primitive,
    options: (state) => component.options(decode(state)),
    controlled: component.controlled,
    callbacks: component.callbacks,
    completions: component.completions ?? {},
    ...(component.lockSlot === undefined ? {} : { lockSlot: component.lockSlot }),
    ...(component.mirror === undefined ? {} : { mirror: component.mirror }),
    fold: (state, snapshot, reason) => component.fold(decode(state), snapshot, reason),
    guard: (state, snapshot, reason) => component.guard?.(decode(state), snapshot, reason) ?? true,
    foldkitEvents: component.text === undefined ? {} : { [component.text]: ["input"] },
  };
};

/** Names the shape of a component for the compiler. It registers nothing. */
export const defineComponent = <State, Slot extends string>(
  component: Component<State, Slot>,
): Component<State, Slot> => component;

/**
 * Applies a Message to one component's state. It returns the same object when
 * the Message is about another instance. Skip calling it to refuse a change;
 * `syncUiState` then reverts the instance.
 */
export const makeUpdate =
  <State, Slot extends string>(component: Component<State, Slot>) =>
  (state: State, message: Message): State => {
    if (message._tag === "CompletedUiSync" || message._tag === "RefusedUiChange") return state;
    if (message.component !== component.name || message.key !== component.key(state)) return state;
    if (message._tag === "TypedUiText") return component.typed?.(state, message.value) ?? state;
    return component.fold(state, message.snapshot, message.reason);
  };

// ── Bind phase: Mount ───────────────────────────────────────────────────────

// Args are frozen when the element is inserted. They say which part this is
// and seed the instance; later Model changes arrive through `syncUiState`.
export const BindPart = Mount.defineStream("BindUiPart", {
  args: {
    component: Schema.String,
    key: Schema.String,
    slot: Schema.String,
    props: Schema.Record(Schema.String, Schema.Unknown),
    state: Schema.Unknown,
    /** The app id the part was rendered with (`PartsConfig.anchor`). Empty: the lone registry. */
    anchor: Schema.String,
  },
  messages: [Message],
  // The registry check runs before the Stream exists, so a failure in dev is the
  // Mount's own failure (Foldkit logs it as an unhandled Mount failure). Inside
  // `Stream.callback` it would die in a forked fiber and the Stream would hang.
  execute: ({ element, component, key, slot, props, state, anchor }) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // A Mount cannot `yield*` the Resource: its static requirement is only
        // Scope, and the context it runs in holds Foldkit's own services, not the
        // app's Resources. The layer leaves the same registry on an element above
        // the app, and the Mount finds it from its own element.
        const registry = findRegistry(element, anchor);
        const binding = Option.flatMap(registry, (r) =>
          Option.fromNullishOr(r.bindings.get(component)),
        );
        if (
          Option.isNone(registry) ||
          Option.isNone(binding) ||
          !(element instanceof HTMLElement)
        ) {
          // A control that binds nothing looks like a hung app. Say so in the DOM,
          // where a dump shows it, and fail loudly in dev.
          const unbound = `${component}:${slot}`;
          element.setAttribute(UNBOUND_ATTRIBUTE, unbound);
          const reason = Option.isNone(registry)
            ? `no registry for anchor "${anchor}" above this element (is kit.layer(container) provided, and is the part inside the anchor's subtree?)`
            : Option.isNone(binding)
              ? `the registry has no binding for "${component}"`
              : "the element is not an HTMLElement";
          const message = `[foldlab] ${unbound} is unbound: ${reason}.`;
          if (isDev()) return yield* Effect.die(new Error(message));
          console.error(message);
          return Stream.empty;
        }
        return Stream.callback<Message>((queue) =>
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() =>
                attach(
                  registry.value,
                  component,
                  binding.value,
                  key,
                  state,
                  slot,
                  props,
                  element,
                  (change: Change) => {
                    Queue.offerUnsafe(
                      queue,
                      change.refused
                        ? Message.RefusedUiChange({
                            component,
                            key,
                            snapshot: change.snapshot,
                            reason: change.reason,
                          })
                        : Message.ChangedUiState({
                            component,
                            key,
                            snapshot: change.snapshot,
                            reason: change.reason,
                          }),
                    );
                  },
                ),
              ),
              (release) => Effect.sync(release),
            );
            return yield* Effect.never;
          }),
        );
      }),
    ),
});

// ── Bind phase: Model -> instance ───────────────────────────────────────────

const Spec = Schema.Struct({ component: Schema.String, key: Schema.String, state: Schema.Unknown });
export type Spec = typeof Spec.Type;

/** Describes one component's Model slice for `syncUiState`. */
export const specOf = <State, Slot extends string>(
  component: Component<State, Slot>,
  state: State,
): Spec => ({ component: component.name, key: component.key(state), state });

/**
 * Confirms the Model's ui state into the mounted instances. Return it from
 * `update` after every Message that can change ui state. It is a confirmation
 * when the instance already acked the change, and a revert when `update`
 * refused it. A part that is not mounted ignores it.
 */
export const syncUiState = Command.define("SyncUiState", {
  args: { specs: Schema.Array(Spec) },
  messages: [Message.CompletedUiSync],
  execute: ({ specs }) =>
    Effect.gen(function* () {
      const registry = yield* UiRegistry;
      for (const spec of specs) sync(registry, spec.component, spec.key, spec.state);
      return Message.CompletedUiSync();
    }),
});

// ── Render phase: parts ─────────────────────────────────────────────────────

export type PartsConfig<AppMessage> = Readonly<{
  /** Wraps ui-sdk's Message into the app's. */
  toMessage: (message: Message) => AppMessage;
  /** The container id of the app, when several apps share one parent. See `registry.ts`. */
  anchor?: string;
}>;

/** Per-call options of a part. `render` swaps the element: a trigger rendered as `a`. */
export type PartOptions = Readonly<{ render?: Tag }>;

export type Part<AppMessage> = (
  props: PartProps,
  attributes?: ReadonlyArray<Attribute<AppMessage>>,
  children?: ReadonlyArray<Html | string>,
  options?: PartOptions,
) => Html;

export type Parts<AppMessage, Slot extends string> = Readonly<Record<Slot, Part<AppMessage>>> &
  Readonly<{
    /**
     * One part's computed attributes, for wiring it onto an element you render
     * yourself, such as a Field's description and error ids onto a combobox
     * input. `only` names the attributes to keep.
     */
    attributes: (
      slot: Slot,
      props?: PartProps,
      only?: ReadonlyArray<string>,
    ) => ReadonlyArray<Attribute<AppMessage>>;
  }>;

const toAttributes = <AppMessage>(
  h: HtmlBuilder<AppMessage>,
  attrs: Attrs,
): ReadonlyArray<Attribute<AppMessage>> => {
  const result: Array<Attribute<AppMessage>> = [];
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    result.push(name === "value" ? h.Value(value) : h.Attribute(name, value));
  }
  return result;
};

// A button's own attributes mean nothing on another element: `type` is dropped, and
// `disabled` becomes `aria-disabled`, which is what a disabled link can say.
const swapped = (attrs: Attrs, tag: Tag, own: Tag): Attrs => {
  if (tag === own || own !== "button") return attrs;
  const rest = Object.fromEntries(
    Object.entries(attrs).filter(([name]) => name !== "type" && name !== "disabled"),
  );
  return attrs["disabled"] === undefined ? rest : { ...rest, "aria-disabled": "true" };
};

export const makeParts =
  <State, Slot extends string>(component: Component<State, Slot>) =>
  <AppMessage>(
    state: State,
    h: HtmlBuilder<AppMessage>,
    config: PartsConfig<AppMessage>,
  ): Parts<AppMessage, Slot> => {
    const key = component.key(state);
    const rendered = renderPhase(
      component.primitive,
      { ...component.options(state), id: key },
      component.renderState?.(state),
    );
    const part =
      (slot: Slot): Part<AppMessage> =>
      (given, attributes = [], children = [], options = {}) => {
        const tag = options.render ?? component.tags[slot];
        const props = component.keepMounted?.includes(slot)
          ? { keepMounted: true, ...given }
          : given;
        if (!rendered.present(slot, props)) return h.empty;
        const shown = swapped(rendered.attrs(slot, props), tag, component.tags[slot]);
        // `hidden` would make the closed panel `display: none` for good, and the preflight
        // layer wins over any override, so a kept panel is marked closed instead and CSS hides it.
        const own =
          props["keepMounted"] === true && shown["hidden"] !== undefined
            ? {
                ...Object.fromEntries(Object.entries(shown).filter(([name]) => name !== "hidden")),
                "data-closed": "",
              }
            : shown;
        const mount = component.bound.includes(slot)
          ? [
              h.OnMount(
                Mount.mapMessage(
                  BindPart({
                    component: component.name,
                    key,
                    slot,
                    props,
                    state,
                    anchor: config.anchor ?? "",
                  }),
                  config.toMessage,
                ),
              ),
            ]
          : [];
        const typed =
          slot === component.text
            ? [
                h.OnInput((value: string) =>
                  config.toMessage(Message.TypedUiText({ component: component.name, key, value })),
                ),
              ]
            : [];
        const all = [
          ...toAttributes(h, own),
          ...typed,
          // Always keyed. A Mount runs once, when its element is inserted, and Foldkit
          // patches a same-tag sibling in place. Without a key, a part from another
          // component (after a page change) reuses this element and keeps the old binding.
          h.Key(`${component.name}:${key}:${slot}:${tag}:${JSON.stringify(props)}`),
          ...attributes,
          ...mount,
        ];
        return tag === "input" ? h.input(all) : tag === "img" ? h.img(all) : h[tag](all, children);
      };
    const attributes = (slot: Slot, props: PartProps = {}, only?: ReadonlyArray<string>) => {
      const own = rendered.attrs(slot, props);
      const kept =
        only === undefined
          ? own
          : Object.fromEntries(Object.entries(own).filter(([name]) => only.includes(name)));
      return toAttributes(h, kept);
    };
    const built = Object.fromEntries(
      (Object.keys(component.tags) as Array<Slot>).map((slot) => [slot, part(slot)]),
    );
    return { ...(built as Record<Slot, Part<AppMessage>>), attributes };
  };
