// Preferences (`createPreference`, `createColorScheme`): a saved value shown on a
// `data-*` attribute so CSS styles by it from the first paint. React's `Preferences`
// element does three jobs; here each one has a home.
//   1. First paint: put `preferencesScript(list)` inline in `index.html`. It runs before
//      Foldkit starts, so there is no flash.
//   2. Global preferences on `<html>`: `watchPreferences` writes them, since a view
//      cannot reach `<html>`. It writes once on subscribing, and on every change.
//   3. Non-global preferences: the Message carries every value by attribute, the Model
//      keeps them, and the view puts `h.Attribute(attribute, value)` on its element.
import { createColorScheme, createPreference, preferencesScript } from "@ui-sdk/core";
import type { PreferenceLike } from "@ui-sdk/core";
import { Schema, type Stream } from "effect";
import { fromListener } from "./internal/stream.ts";

export { createColorScheme, createPreference, preferencesScript };
export type { PreferenceLike };

export const PreferenceValues = Schema.Record(Schema.String, Schema.String);

// What a watch reads. A `createPreference` result with no storage is not a `PreferenceLike`
// under `exactOptionalPropertyTypes`, and none of it is needed here.
type Watched = Pick<PreferenceLike, "attribute" | "global" | "get" | "subscribe">;

const valuesOf = (list: ReadonlyArray<Watched>) =>
  Object.fromEntries(list.map((preference) => [preference.attribute, preference.get().value]));

const show = (list: ReadonlyArray<Watched>) => {
  for (const preference of list) {
    if (preference.global) {
      document.documentElement.setAttribute(preference.attribute, preference.get().value);
    }
  }
};

/** A Stream of every value by attribute name, now and after each change. Return it from a Subscription. */
export const watchPreferences = <A>(
  list: ReadonlyArray<Watched>,
  toMessage: (values: Readonly<Record<string, string>>) => A,
): Stream.Stream<A> =>
  fromListener<A>((emit) => {
    const publish = () => {
      show(list);
      emit(toMessage(valuesOf(list)));
    };
    const stops = list.map((preference) => preference.subscribe(publish));
    publish();
    return () => stops.forEach((stop) => stop());
  });
