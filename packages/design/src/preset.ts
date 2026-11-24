import { definePreset } from "@pandacss/dev";

const pair = (light: string, dark: string) => ({ value: { base: light, _dark: dark } });

/**
 * The one look: warm paper, dark ink, a magenta accent, square corners, and
 * Google Sans for text with IBM Plex Mono for figures and metadata. Flat like a
 * blueprint: hairline frames, crosshair corners, no shadows, one filled cell.
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
      height: "100%",
      overflow: "hidden",
      overscrollBehavior: "none",
    },
    body: {
      height: "100dvh",
      overflow: "hidden",
      overscrollBehavior: "none",
      fontSize: "15px",
      lineHeight: "1.6",
    },
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
    // A side menu follows the finger, then settles. `swipeDrawer` sets these
    // attributes and the two offsets on `<html>` while a drag is in flight.
    "[data-swiping] [data-swipe-panel]": {
      animation: "none !important",
      transition: "none !important",
      translate: "calc(var(--swipe-offset, 0px) - 100%) 0 !important",
    },
    "[data-swiping] [data-swipe-backdrop]": {
      animation: "none !important",
      transition: "none !important",
      opacity: "var(--swipe-progress, 0) !important",
    },
    "[data-settling] [data-swipe-panel], [data-swiped] [data-swipe-panel]": {
      animation: "none !important",
      translate: "calc(var(--swipe-offset, 0px) - 100%) 0 !important",
    },
    "[data-settling] [data-swipe-panel]": {
      transition: "translate var(--swipe-settle, 240ms) {easings.out} !important",
    },
    "[data-settling] [data-swipe-backdrop], [data-swiped] [data-swipe-backdrop]": {
      animation: "none !important",
      opacity: "var(--swipe-progress, 0) !important",
    },
    "[data-settling] [data-swipe-backdrop]": {
      transition: "opacity var(--swipe-settle, 240ms) {easings.out} !important",
    },
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
        riseIn: { from: { opacity: "0", translate: "0 4px" } },
        blink: { "50%": { opacity: "0.25" } },
      },
      textStyles: {
        // Page names: heavy uppercase with a little air, like the site's headings.
        display: {
          value: {
            fontFamily: "sans",
            fontWeight: 800,
            letterSpacing: "0.025em",
            lineHeight: "1.1",
            textTransform: "uppercase",
            fontVariantNumeric: "tabular-nums",
          },
        },
        // Gutter labels: small mono capitals spaced wide.
        caps: {
          value: {
            fontFamily: "mono",
            fontSize: "11px",
            fontWeight: 400,
            letterSpacing: "0.18em",
            lineHeight: "1.2",
            textTransform: "uppercase",
          },
        },
        meta: {
          value: {
            fontFamily: "mono",
            fontSize: "xs",
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "0",
          },
        },
      },
      recipes: {
        /**
         * Every button: flat and square. `primary` is the one filled magenta
         * cell on a screen; `line` is a hairline cell; `ghost` has no edge.
         */
        button: {
          className: "btn",
          base: {
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "8px",
            flexShrink: 0,
            border: "1px solid transparent",
            backgroundColor: "transparent",
            color: "fg",
            fontFamily: "mono",
            fontSize: "xs",
            letterSpacing: "caps",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
            cursor: "pointer",
            userSelect: "none",
            transitionDuration: "120ms",
            transitionTimingFunction: "out",
            "& svg": { flexShrink: 0 },
            transitionProperty: "color, background-color, border-color, scale",
            // A press answers at once: the button gives a little under the finger.
            _active: { scale: "0.97" },
            _disabled: { opacity: "0.4", cursor: "not-allowed", _active: { scale: "1" } },
          },
          variants: {
            tone: {
              primary: {
                backgroundColor: "accent",
                borderColor: "accent",
                color: "white",
                _hover: { backgroundColor: "accentHover", borderColor: "accentHover" },
                _disabled: { _hover: { backgroundColor: "accent" } },
              },
              line: {
                borderColor: "border",
                backgroundColor: "bg",
                _hover: {
                  borderColor: "borderStrong",
                  backgroundColor: "bgSubtle",
                  color: "accent",
                },
              },
              ghost: {
                color: "fgMuted",
                _hover: { backgroundColor: "bgHover", color: "accent" },
              },
              danger: {
                borderColor: "border",
                color: "danger",
                _hover: { borderColor: "danger", backgroundColor: "dangerSubtle" },
              },
            },
            size: {
              md: { height: "40px", paddingInline: "14px" },
              sm: { height: "32px", paddingInline: "10px" },
              icon: { width: "40px", height: "40px", padding: "0" },
              iconSm: { width: "32px", height: "32px", padding: "0" },
            },
          },
          defaultVariants: { tone: "line", size: "md" },
        },
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
          "4xl": { value: "40px" },
          "5xl": { value: "56px" },
          "6xl": { value: "80px" },
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
          borderStrong: pair("#f6a9cb", "#6b3d52"),
          fg: pair("#431407", "#fbe8ee"),
          fgMuted: pair("#8a6a78", "#b99aa8"),
          fgFaint: pair("#b08f9d", "#80636f"),
          accent: pair("#e60076", "#f472b6"),
          ok: pair("#15803d", "#62c073"),
          warn: pair("#b45309", "#f5a623"),
          danger: pair("#dc2626", "#ff6166"),
          accentHover: pair("#c4005f", "#f9a8d4"),
          accentSubtle: pair("#fdf2f8", "#2a1520"),
          heading: pair("#500724", "#fce7f3"),
          dangerSubtle: pair("#fef2f2", "#2a1414"),
        },
      },
    },
  },
});
