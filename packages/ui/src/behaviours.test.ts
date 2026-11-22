// @vitest-environment happy-dom
// Cross-cutting behaviours: render swap, controllers, change reasons, uncontrolled
// entries, and the page-level modules (agent, shortcuts, overlays, preferences).
import { createOverlays } from "@ui-sdk/core/overlays";
import { Effect, Stream } from "effect";
import { Scene } from "foldkit/test";
import { afterEach, expect, test } from "vite-plus/test";
import {
  Accordion,
  Agent,
  Controllers,
  Dialog,
  Message,
  Overlays,
  Preferences,
  Shortcuts,
  Ui,
  UiRegistry,
} from "./index.ts";
import { bindingOf, defineComponent, makeUpdate } from "./core.ts";
import { resolveBinds } from "./testing.ts";
import { attach, type Change, makeRegistry, type Registry } from "./internal/bind.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-theme");
});

// ── render swap ─────────────────────────────────────────────────────────────

type SwapModel = { readonly help: Accordion.State };
const swapView = (model: SwapModel, h: Parameters<typeof Accordion.parts<unknown>>[1]) => {
  const accordion = Accordion.parts(model.help, h, { toMessage: (message: unknown) => message });
  return {
    title: "swap",
    body: h.div(
      [],
      [
        accordion.trigger({ value: "a" }, [], ["plain"]),
        accordion.trigger({ value: "b" }, [h.Href("/b")], ["link"], { render: "a" }),
      ],
    ),
  };
};

test("a part renders as another element with the same attributes and the same Mount", () => {
  Scene.scene(
    { update: (model: SwapModel) => ({ model, commands: [] }), view: swapView as never },
    Scene.given({ help: Accordion.init({ key: "help" }) }),
    Scene.tap((sim) => expect(sim.mounts).toHaveLength(2)),
    resolveBinds((message) => message),
    Scene.expect(Scene.selector('button[data-slot="accordion-trigger"]')).toExist(),
    Scene.expect(Scene.selector('a[data-slot="accordion-trigger"]')).toHaveAttr("href", "/b"),
    Scene.expect(Scene.selector('a[data-slot="accordion-trigger"]')).toHaveAttr(
      "aria-expanded",
      "false",
    ),
    Scene.expect(Scene.selector("a[type]")).not.toExist(),
  );
});

// ── controllers ─────────────────────────────────────────────────────────────

const mounted = (
  registry: Registry,
  component: typeof Accordion.component,
  changes: Array<Change>,
) => {
  const el = document.body.appendChild(document.createElement("button"));
  return attach(
    registry,
    component.name,
    bindingOf(component),
    "help",
    Accordion.init({ key: "help" }),
    "trigger",
    { value: "a" },
    el,
    (change) => changes.push(change),
  );
};
const run = (registry: Registry, command: { effect: Effect.Effect<unknown, never, UiRegistry> }) =>
  Effect.runPromise(command.effect.pipe(Effect.provideService(UiRegistry, registry)));

test("a controller Command drives the live instance and the Model hears an imperative change", async () => {
  const registry = makeRegistry(new Map());
  const changes: Array<Change> = [];
  const release = mounted(registry, Accordion.component, changes);
  const state = Accordion.init({ key: "help" });
  await run(registry, Controllers.controllerOf(Accordion.component, state).setValue(["b"]));
  expect(changes).toEqual([{ snapshot: { value: ["b"] }, reason: "imperative", refused: false }]);
  const message = Message.ChangedUiState({
    component: "accordion",
    key: "help",
    snapshot: { value: ["b"] },
    reason: "imperative",
  });
  expect(Accordion.update(state, message).value).toEqual(["b"]);
  release();
});

test("a controller Command for an unmounted instance does nothing", async () => {
  const registry = makeRegistry(new Map());
  const state = Accordion.init({ key: "help" });
  await run(registry, Controllers.controllerOf(Accordion.component, state).call("setValue", ["b"]));
  await run(registry, Controllers.controllerOf(Accordion.component, state).call("noSuchMethod"));
  expect(registry.entries.size).toBe(0);
});

test("a controller opens a dialog from outside", async () => {
  const registry = makeRegistry(new Map());
  const changes: Array<Change> = [];
  const state = Dialog.init({ key: "help" });
  const el = document.body.appendChild(document.createElement("button"));
  attach(registry, "dialog", bindingOf(Dialog.component), "help", state, "trigger", {}, el, (c) =>
    changes.push(c),
  );
  await run(registry, Controllers.controllerOf(Dialog.component, state).open());
  expect(changes[0]).toMatchObject({ snapshot: { open: true }, reason: "imperative" });
});

// ── change reasons ──────────────────────────────────────────────────────────

test("the reason reaches the guard, and a veto is details.cancel()", async () => {
  const seen: Array<string> = [];
  const guarded = defineComponent({
    ...Accordion.component,
    guard: (_state, _snapshot, reason) => {
      seen.push(reason);
      return reason !== "escape-key";
    },
  });
  const registry = makeRegistry(new Map());
  const changes: Array<Change> = [];
  mounted(registry, guarded, changes);
  const state = Accordion.init({ key: "help" });
  const controller = Controllers.controllerOf(guarded, state);
  await run(registry, controller.call("setValue", ["a"], { reason: "escape-key" }));
  await run(registry, controller.call("setValue", ["a"], { reason: "item-press" }));
  expect(seen).toEqual(["escape-key", "item-press"]);
  expect(changes.map((c) => [c.reason, c.refused])).toEqual([
    ["escape-key", true],
    ["item-press", false],
  ]);
});

test("the reason reaches fold through update", () => {
  const seen: Array<string | undefined> = [];
  const logged = defineComponent({
    ...Accordion.component,
    fold: (state, snapshot, reason) => {
      seen.push(reason);
      return Accordion.component.fold(state, snapshot);
    },
  });
  const state = Accordion.init({ key: "help" });
  makeUpdate(logged)(
    state,
    Message.ChangedUiState({
      component: "accordion",
      key: "help",
      snapshot: { value: ["a"] },
      reason: "item-press",
    }),
  );
  expect(seen).toEqual(["item-press"]);
});

// ── uncontrolled entries ────────────────────────────────────────────────────

test("an uncontrolled entry folds its own state and is never synced back", () => {
  const change = Message.ChangedUiState({
    component: "accordion",
    key: "faq",
    snapshot: { value: ["q"] },
    reason: "item-press",
  });
  const entries = { faq: Accordion.component, help: Dialog.component };
  const start = { faq: Accordion.init({ key: "faq" }), help: Dialog.init({ key: "help" }) };
  const own = Ui.define(entries, { uncontrolled: ["faq"] }).update(start, change);
  expect(own.model.faq.value).toEqual(["q"]);
  expect(own.commands).toHaveLength(1);
  const both = Ui.define(entries, { uncontrolled: ["faq", "help"] }).update(start, change);
  expect(both.model.faq.value).toEqual(["q"]);
  expect(both.commands).toEqual([]);
});

// ── agent ───────────────────────────────────────────────────────────────────

test("the agent sees an instance in the registry and its act goes through our callbacks", async () => {
  const agent = Agent.createAgent();
  const registry = makeRegistry(new Map());
  const changes: Array<Change> = [];
  const el = document.body.appendChild(document.createElement("button"));
  attach(
    registry,
    "dialog",
    bindingOf(Dialog.component),
    "help",
    Dialog.init({ key: "help" }),
    "trigger",
    {},
    el,
    (change) => changes.push(change),
  );
  const [target] = agent.snapshot().filter((c) => c.component === "dialog");
  expect(target?.actions).toContain("setOpen");
  const result = await agent.act({
    steps: [{ ref: target!.ref, action: "setOpen", args: [true] }],
  });
  expect(result.error).toBeUndefined();
  expect(changes[0]).toMatchObject({ snapshot: { open: true }, refused: false });
  expect(Agent.agentTools.map((tool) => tool.name)).toEqual(["snapshot", "act", "query"]);
});

// ── shortcuts, overlays, preferences ────────────────────────────────────────

test("a shortcut Stream emits a Message per press while it runs", async () => {
  const stream = Shortcuts.shortcutStream("ctrl+k", (event) => event.key).pipe(Stream.take(1));
  const done = Effect.runPromise(Stream.runCollect(stream));
  await tick();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  expect(await done).toEqual(["k"]);
  expect(Shortcuts.shortcuts.list().filter((s) => s.keys === "ctrl+k")).toEqual([]);
});

test("shortcutHint formats for the platform it is given", () => {
  expect(Shortcuts.shortcutHint("mod+k", true).text).toContain("⌘");
  expect(Shortcuts.shortcutHint("mod+k").text).toContain("Ctrl");
});

test("overlay entries stream: the current ones, then each change, with a host attached", async () => {
  const registry = createOverlays();
  const stream = Overlays.watchOverlays((entries) => entries.map((e) => e.type), registry).pipe(
    Stream.take(2),
  );
  const done = Effect.runPromise(Stream.runCollect(stream));
  await tick();
  expect(registry.hasHost()).toBe(true);
  registry.mount("toaster", {}, () => true);
  expect(await done).toEqual([[], ["toaster"]]);
  expect(registry.hasHost()).toBe(false);
});

test("a preference stream writes global ones on html and reports every value", async () => {
  const theme = Preferences.createPreference({
    values: ["light", "dark"],
    defaultValue: "light",
    attribute: "data-theme",
    global: true,
  });
  const stream = Preferences.watchPreferences([theme], (values) => values).pipe(Stream.take(2));
  const done = Effect.runPromise(Stream.runCollect(stream));
  await tick();
  theme.set("dark");
  expect(await done).toEqual([{ "data-theme": "light" }, { "data-theme": "dark" }]);
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
});
