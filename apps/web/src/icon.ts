import { type GlyphName, glyphs } from "@mizook/design/icons";
import { type Shape, type Tone, lockup, loop, loopViewBox, mark } from "@mizook/design/logo";
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

const toneColor: Record<Tone, string> = {
  ink: "var(--colors-heading)",
  accent: "var(--colors-accent)",
  soft: "var(--colors-border-strong)",
};

const shapes = <M>(h: HtmlBuilder<M>, list: ReadonlyArray<Shape>): ReadonlyArray<Html> =>
  list.map((shape) =>
    shape.kind === "rect"
      ? h.rect(
          [
            h.X(String(shape.x)),
            h.Y(String(shape.y)),
            h.Width(String(shape.w)),
            h.Height(String(shape.h)),
            h.Style({ fill: toneColor[shape.tone] }),
          ],
          [],
        )
      : h.path(
          [
            h.D(shape.d),
            h.Fill("none"),
            h.StrokeWidth(String(shape.width)),
            h.StrokeLinecap("square"),
            h.StrokeLinejoin("miter"),
            h.Style({ stroke: toneColor[shape.tone] }),
          ],
          [],
        ),
  );

/** The logo: the thread mark, then MIZ∞K with the loop for the OO. */
export const logo = <M>(h: HtmlBuilder<M>): Html =>
  h.span(
    [h.Role("img"), h.AriaLabel("Mizook"), h.Style({ whiteSpace: "nowrap" })],
    [
      h.svg(
        [
          h.ViewBox("0 0 32 32"),
          h.AriaHidden(true),
          h.Style({
            display: "inline-block",
            width: `${lockup.markSize}em`,
            height: `${lockup.markSize}em`,
            verticalAlign: `-${lockup.markDrop}em`,
            marginRight: `${lockup.markGap}em`,
          }),
        ],
        shapes(h, mark),
      ),
      "Miz",
      h.svg(
        [
          h.ViewBox(loopViewBox),
          h.AriaHidden(true),
          h.Style({
            display: "inline-block",
            height: `${lockup.loopHeight}em`,
            verticalAlign: `-${lockup.loopDrop}em`,
            margin: `0 ${lockup.loopAfter}em 0 ${lockup.loopBefore}em`,
          }),
        ],
        shapes(h, loop),
      ),
      "k",
    ],
  );
