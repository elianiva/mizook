import { definePreset } from "@pandacss/dev";

const pair = (light: string, dark: string) => ({ value: { base: light, _dark: dark } });

/**
 * The one look: warm paper, dark ink, a magenta accent, square corners, and
 * Google Sans for text with IBM Plex Mono for figures and metadata.
 */
export const mizookPreset = definePreset({
  name: "mizook",
  conditions: {
    extend: {
      dark: "@media (prefers-color-scheme: dark)",
      // A touch press must not leave a hover state behind.
      hover: { "@media (hover: hover)": { "&:is(:hover, [data-hover])": "@slot" } },
    },
  },
  globalCss: {
    "*, *::before, *::after": { borderRadius: "0" },
    html: {
      colorScheme: "light dark",
      backgroundColor: "bg",
      color: "fg",
      fontFamily: "sans",
      fontSize: "16px",
      WebkitFontSmoothing: "antialiased",
      textRendering: "optimizeLegibility",
      WebkitTextSizeAdjust: "100%",
      WebkitTapHighlightColor: "transparent",
    },
    body: { minHeight: "100vh", fontSize: "15px", lineHeight: "1.6" },
    "button, input, select, textarea": {
      fontFamily: "inherit",
      fontSize: "inherit",
      color: "inherit",
    },
    "button, a, select, summary": { touchAction: "manipulation" },
    "h1, h2, h3": { textWrap: "balance" },
    p: { textWrap: "pretty" },
    "::selection": { backgroundColor: "accent", color: "bg" },
    ":focus-visible": { outline: "2px solid var(--colors-accent)", outlineOffset: "2px" },
    "@media (prefers-reduced-motion: reduce)": {
      "*, *::before, *::after": {
        animationDuration: "1ms !important",
        animationIterationCount: "1 !important",
        transitionDuration: "1ms !important",
      },
    },
  },
  theme: {
    extend: {
      keyframes: {
        fadeIn: { from: { opacity: "0" } },
        popIn: { from: { opacity: "0", scale: "0.96" } },
        slideIn: { from: { translate: "-100% 0" } },
      },
      tokens: {
        fonts: {
          sans: { value: "'Google Sans Variable', system-ui, sans-serif" },
          mono: { value: "'IBM Plex Mono', ui-monospace, monospace" },
        },
        fontSizes: {
          xs: { value: "12px" },
          sm: { value: "14px" },
          md: { value: "15px" },
          lg: { value: "16px" },
          xl: { value: "19px" },
          "2xl": { value: "26px" },
          "3xl": { value: "30px" },
        },
        letterSpacings: {
          tight: { value: "-0.02em" },
          tighter: { value: "-0.04em" },
          caps: { value: "0.06em" },
        },
        easings: {
          // Fast start, soft landing: a press or an opening panel answers at once.
          out: { value: "cubic-bezier(0.23, 1, 0.32, 1)" },
        },
      },
      semanticTokens: {
        colors: {
          bg: pair("#fff9f5", "#17100f"),
          bgSubtle: pair("#fff1f5", "#1f1416"),
          bgHover: pair("#ffe8f0", "#2a1a1f"),
          border: pair("#fbdbe8", "#3a2530"),
          borderStrong: pair("#f4a9c6", "#6b3d52"),
          fg: pair("#431407", "#fbe8ee"),
          fgMuted: pair("#8a6a78", "#b99aa8"),
          fgFaint: pair("#b08f9d", "#80636f"),
          accent: pair("#c0175f", "#f472b6"),
          ok: pair("#15803d", "#62c073"),
          warn: pair("#b45309", "#f5a623"),
          danger: pair("#dc2626", "#ff6166"),
        },
      },
    },
  },
});
