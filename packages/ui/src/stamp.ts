// Lets a provider that does not speak `data-slot` share our Panda theme.
// `@foldkit/ui` hands each part's attributes through `toView`. Appending our
// `data-slot` to those arrays is enough: the theme keys on slot names, not on a
// provider's own hooks. Both providers write `data-closed` for leave states, so
// the state half of the theme is already shared.
import { childAttributes, type ChildAttribute, type HtmlBuilder } from "foldkit/html";

export const stamp = <AppMessage>(
  h: HtmlBuilder<AppMessage>,
  slot: string,
): ReadonlyArray<ChildAttribute> => childAttributes([h.DataAttribute("slot", slot)]);
