// @vitest-environment happy-dom
import { Context, Effect, Layer, Option, Predicate } from "effect";
import { Command, given, message, model, story } from "foldkit/story";
import { expect, test } from "vite-plus/test";
import { Accordion, Combobox, Message, specOf, syncUiState, Ui, UiRegistry } from "./index.ts";
import { attach, LOCK_MARKER } from "./internal/bind.ts";
import { findRegistry } from "./registry.ts";
import { bindingOf } from "./core.ts";

const change = (component: string, key: string, snapshot: Record<string, unknown>) =>
  Message.ChangedUiState({ component, key, snapshot, reason: "test" });

test("the facade folds a Message into the one component it names, and returns one sync Command", () => {
  const ui = Ui.define({
    people: Combobox.component,
    help: Accordion.component,
    faq: Accordion.component,
  });
  const start = {
    people: Combobox.init({ key: "people", items: [{ value: "a", label: "Ada" }] }),
    help: Accordion.init({ key: "help" }),
    faq: Accordion.init({ key: "faq" }),
  };
  const result = ui.update(start, change("accordion", "faq", { value: ["q1"] }));
  expect(result.model.faq.value).toEqual(["q1"]);
  expect(result.model.help).toBe(start.help);
  expect(result.model.people).toBe(start.people);
  expect(result.commands).toHaveLength(1);
  expect(ui.update(result.model, Message.CompletedUiSync()).commands).toEqual([]);
});

test("an app can step out of the facade: one component, wired by hand", () => {
  type Model = { readonly help: Accordion.State };
  const update = (m: Model, msg: Message) => {
    // A sync's own completion must not start another one.
    if (Predicate.isTagged(msg, "CompletedUiSync")) return { model: m, commands: [] };
    const help = Accordion.update(m.help, msg);
    return {
      model: { help },
      commands: [syncUiState({ specs: [specOf(Accordion.component, help)] })],
    };
  };
  story(
    update,
    given<Model>({ help: Accordion.init({ key: "help" }) }),
    message(change("accordion", "help", { value: ["a"] })),
    Command.resolveAll([syncUiState, Message.CompletedUiSync()]),
    model((m) => expect(m.help.value).toEqual(["a"])),
  );
});

test("the registry is a Resource: Commands reach it, and closing the scope releases it", async () => {
  const state = Accordion.init({ key: "help", value: ["a"] });
  const parent = document.body.appendChild(document.createElement("div"));
  const container = parent.appendChild(document.createElement("div"));
  const registry = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(Ui.layerOf([Accordion.component], container).layer);
        const found = Context.get(context, UiRegistry);
        // A Mount reaches the same registry through the container.
        expect(findRegistry(container)).toEqual(Option.some(found));
        const el = document.createElement("button");
        document.body.append(el);
        attach(
          found,
          "accordion",
          bindingOf(Accordion.component),
          "help",
          state,
          "trigger",
          { value: "a" },
          el,
          () => {},
        );
        const sync = syncUiState({ specs: [specOf(Accordion.component, { ...state, value: [] })] });
        yield* sync.effect.pipe(Effect.provideContext(context));
        expect(found.entries.get("accordion:help")?.instance.get()).toMatchObject({ value: [] });
        return found;
      }),
    ),
  );
  expect(registry.entries.size).toBe(0);
  expect(Option.isNone(findRegistry(container))).toBe(true);
  expect(document.documentElement.hasAttribute(LOCK_MARKER)).toBe(false);
});
