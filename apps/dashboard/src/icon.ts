import { type GlyphName, glyphs } from "@mizook/design/icons";
import type { Html, HtmlBuilder } from "foldkit/html";

/**
 * A glyph in the current text color. It is hidden from screen readers: the
 * control around it carries the name, with `AriaLabel` and `Title`.
 */
export const icon = <M>(h: HtmlBuilder<M>, name: GlyphName, size = 20): Html => {
  const glyph = glyphs[name];
  return h.svg(
    [
      h.ViewBox("0 0 24 24"),
      h.Width(String(size)),
      h.Height(String(size)),
      h.AriaHidden(true),
      h.Fill("fill" in glyph ? "currentColor" : "none"),
      h.Stroke("currentColor"),
      h.StrokeWidth("2"),
      h.StrokeLinecap("square"),
      h.StrokeLinejoin("miter"),
    ],
    [h.path([h.D(glyph.d)], [])],
  );
};
