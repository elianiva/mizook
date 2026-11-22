// Bind phase. The only file that attaches a live ui-sdk instance to an element.
// Instances live in a `Registry`, outside the Model, keyed by the key the Model
// carries. An entry is created by the first part that mounts and destroyed when
// the last one unmounts. A Registry is a value: the app provides one as a
// Foldkit Resource (see `registry.ts`), and a test makes its own. This module
// holds no mutable state of its own.
import type { PrimitiveInstance } from "@ui-sdk/core";
import { bind } from "@ui-sdk/core/renderer";
import type { PartProps, Primitive } from "./render.ts";

/** The controlled options of one instance, by ui-sdk option name. */
export type Snapshot = Readonly<Record<string, unknown>>;
/** `refused` changes were vetoed by the guard: the instance did not move. */
export type Change = Readonly<{ snapshot: Snapshot; reason: string; refused: boolean }>;

export type Binding = Readonly<{
  primitive: Primitive;
  /** Model state in, ui-sdk options out. Pure. */
  options: (state: unknown) => Readonly<Record<string, unknown>>;
  /** Option names the Model controls. */
  controlled: ReadonlyArray<string>;
  /** ui-sdk callback option to the controlled option it asks to change. */
  callbacks: Readonly<Record<string, string>>;
  /** Completion callbacks (`onOpenChangeComplete`): callback option to the snapshot key it sets. Never guarded. */
  completions: Readonly<Record<string, string>>;
  /** State after a snapshot lands. Pure and idempotent. */
  fold: (state: unknown, snapshot: Snapshot, reason: string) => unknown;
  /**
   * Synchronous veto, pure. Gets the state the instance holds, the snapshot
   * it asked for and ui-sdk's `details.reason`. False is `details.cancel()`: do not ack, do not call setOptions.
   */
  guard: (state: unknown, snapshot: Snapshot, reason: string) => boolean;
  /** The slot whose bind takes the document scroll lock (a modal's content). */
  lockSlot?: string;
  /** Instance state keys, not controlled, that the Model follows read-only, like a drag draft. */
  mirror?: ReadonlyArray<string>;
  /** DOM events Foldkit owns on a slot, so core does not attach them. */
  foldkitEvents: Readonly<Record<string, ReadonlyArray<string>>>;
}>;

type Entry = {
  instance: PrimitiveInstance;
  readonly key: string;
  readonly binding: Binding;
  readonly sinks: Set<(change: Change) => void>;
  /** What the instance currently believes: the Model's state, plus changes it acked itself. */
  state: unknown;
  leases: number;
  /** Stops the mirror subscription. */
  stop?: () => void;
  /** One binding per element. Attaching the same element again replaces the old one. */
  readonly bound: WeakMap<Element, () => void>;
};

/** Everything the bind phase owns. One per app, and one per test. */
export type Registry = Readonly<{
  /** Component name to Binding. Built from the components the app declares. */
  bindings: ReadonlyMap<string, Binding>;
  entries: Map<string, Entry>;
  /** Adapter modals that hold the document scroll lock. */
  lockOwners: Set<symbol>;
  /** Whether the foreign-lock warning has fired. */
  lockWarning: { fired: boolean };
}>;

export const makeRegistry = (bindings: ReadonlyMap<string, Binding>): Registry => ({
  bindings,
  entries: new Map(),
  lockOwners: new Set(),
  lockWarning: { fired: false },
});

// ── Scroll-lock ownership ───────────────────────────────────────────────────
// Dev-mode check behind the stacking rule: one provider per stacking domain.
// Core writes the lock itself. We cannot hook that write, so we stamp a marker
// on the document while any adapter modal holds the lock, and a lock with no
// marker belongs to someone else.
export const LOCK_MARKER = "data-foldlab-lock";

export const isDev = () => import.meta.env?.DEV === true;

const foreignLock = (doc: Document) =>
  !doc.documentElement.hasAttribute(LOCK_MARKER) &&
  (doc.documentElement.style.overflow === "hidden" || doc.body.style.overflow === "hidden");

const claimLock = (registry: Registry, doc: Document): (() => void) => {
  const { lockOwners, lockWarning } = registry;
  if (isDev() && !lockWarning.fired && lockOwners.size === 0 && foreignLock(doc)) {
    lockWarning.fired = true;
    console.warn(
      "[foldlab] A scroll lock written by another provider (for example @foldkit/ui) is active " +
        "while an adapter modal opens. Locks from two providers do not coordinate: stack modals " +
        'within one provider. See docs/adapter-api.md, "Stacking".',
    );
  }
  const owner = Symbol("lock");
  lockOwners.add(owner);
  doc.documentElement.setAttribute(LOCK_MARKER, "");
  return () => {
    lockOwners.delete(owner);
    if (lockOwners.size === 0) doc.documentElement.removeAttribute(LOCK_MARKER);
  };
};

const registryKey = (component: string, key: string) => `${component}:${key}`;

const snapshotOf = (binding: Binding, state: unknown): Snapshot => {
  const options = binding.options(state);
  return Object.fromEntries(binding.controlled.map((name) => [name, options[name]]));
};

const optionsOf = (entry: Entry) => {
  const { binding } = entry;
  // Ack first, then tell the app: a second interaction in the same tick reads
  // the acked value, and the Message carries everything `update` needs.
  const callback = (option: string) => (value: unknown, details?: { reason?: string }) => {
    const reason = details?.reason ?? "unknown";
    const next = { ...snapshotOf(binding, entry.state), [option]: value };
    const [sink] = entry.sinks;
    if (!binding.guard(entry.state, next, reason)) {
      // Not acking is the veto: core keeps the old option, so nothing moves.
      sink?.({ snapshot: next, reason, refused: true });
      return;
    }
    entry.state = binding.fold(entry.state, next, reason);
    entry.instance.setOptions(optionsOf(entry));
    sink?.({ snapshot: snapshotOf(binding, entry.state), reason, refused: false });
  };
  const callbacks = Object.fromEntries(
    Object.entries(binding.callbacks).map(([name, option]) => [name, callback(option)]),
  );
  // A completion is not a request: the instance already finished, so it is
  // folded without a guard and the Model learns of it.
  const completion = (key: string) => (value: unknown, details?: { reason?: string }) => {
    const next = { ...snapshotOf(binding, entry.state), [key]: value };
    const reason = details?.reason ?? "complete";
    entry.state = binding.fold(entry.state, next, reason);
    const [sink] = entry.sinks;
    sink?.({ snapshot: next, reason, refused: false });
  };
  const completions = Object.fromEntries(
    Object.entries(binding.completions).map(([name, key]) => [name, completion(key)]),
  );
  return { ...binding.options(entry.state), ...callbacks, ...completions, id: entry.key };
};

export const attach = (
  registry: Registry,
  component: string,
  binding: Binding,
  key: string,
  state: unknown,
  slot: string,
  props: PartProps,
  element: HTMLElement,
  sink: (change: Change) => void,
): (() => void) => {
  const id = registryKey(component, key);
  let entry = registry.entries.get(id);
  if (entry === undefined) {
    const created: Entry = {
      // Assigned on the next line: the options it is built from close over `created`.
      instance: undefined as unknown as PrimitiveInstance,
      key,
      binding,
      sinks: new Set(),
      state,
      leases: 0,
      bound: new WeakMap(),
    };
    created.instance = binding.primitive(optionsOf(created));
    const mirror = binding.mirror ?? [];
    if (mirror.length > 0) {
      const read = () => {
        const current = created.instance.get() as Record<string, unknown>;
        return Object.fromEntries(mirror.map((name) => [name, current[name] ?? null]));
      };
      let last = JSON.stringify(read());
      created.stop = created.instance.subscribe(() => {
        const snapshot = read();
        const text = JSON.stringify(snapshot);
        if (text === last) return;
        last = text;
        created.state = binding.fold(created.state, snapshot, "mirror");
        const [sink] = created.sinks;
        sink?.({ snapshot, reason: "mirror", refused: false });
      });
    }
    registry.entries.set(id, created);
    entry = created;
  }
  const held = entry;
  held.leases++;
  held.sinks.add(sink);
  // Lease first, so replacing a binding never takes the count to zero.
  held.bound.get(element)?.();
  const events = binding.foldkitEvents[slot];
  // Before `bind`: core takes the lock inside it, so the check sees what was there first.
  const releaseLock =
    binding.lockSlot === slot ? claimLock(registry, element.ownerDocument) : undefined;
  const unbind = bind(
    held.instance.part(slot, props),
    element,
    events === undefined ? undefined : { by: "framework", attaches: events },
  );
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    unbind();
    releaseLock?.();
    if (held.bound.get(element) === release) held.bound.delete(element);
    held.sinks.delete(sink);
    if (--held.leases === 0) {
      held.stop?.();
      held.instance.destroy();
      if (registry.entries.get(id) === held) registry.entries.delete(id);
    }
  };
  held.bound.set(element, release);
  return release;
};

/** The live instance for a key, if any part of it is mounted. */
export const liveInstance = (registry: Registry, component: string, key: string) =>
  registry.entries.get(registryKey(component, key))?.instance;

/** Destroys every instance and drops every lock claim. Runs when the app's scope closes. */
export const closeRegistry = (registry: Registry) => {
  for (const entry of registry.entries.values()) entry.instance.destroy();
  registry.entries.clear();
  registry.lockOwners.clear();
  if (typeof document !== "undefined") document.documentElement.removeAttribute(LOCK_MARKER);
};

/** Model to instance. Confirms what the instance acked, or reverts it when `update` refused. */
export const sync = (registry: Registry, component: string, key: string, state: unknown) => {
  const entry = registry.entries.get(registryKey(component, key));
  if (entry === undefined) return;
  entry.state = state;
  entry.instance.setOptions(optionsOf(entry));
};
