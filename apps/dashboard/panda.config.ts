import { defineConfig } from "@pandacss/dev";

const pair = (light: string, dark: string) => ({ value: { base: light, _dark: dark } });

export default defineConfig({
  presets: ["@pandacss/preset-base", "@pandacss/preset-panda"],
  include: ["./src/**/*.ts"],
  outdir: "styled-system",
  preflight: true,
  conditions: { extend: { dark: "@media (prefers-color-scheme: dark)" } },
  globalCss: {
    "*, *::before, *::after": { borderRadius: "0" },
    html: {
      colorScheme: "light dark",
      backgroundColor: "bg",
      color: "fg",
      fontFamily: "sans",
      fontSize: "13px",
      lineHeight: "1.5",
      WebkitFontSmoothing: "antialiased",
      textRendering: "optimizeLegibility",
    },
    body: { minHeight: "100vh" },
    "button, input, select": { fontFamily: "inherit", fontSize: "inherit", color: "inherit" },
    "::selection": { backgroundColor: "accent", color: "bg" },
    ":focus-visible": { outline: "2px solid var(--colors-accent)", outlineOffset: "2px" },
  },
  theme: {
    extend: {
      tokens: {
        fonts: {
          sans: { value: "'Google Sans Variable', system-ui, sans-serif" },
          mono: { value: "'IBM Plex Mono', ui-monospace, monospace" },
        },
        fontSizes: {
          xs: { value: "11px" },
          sm: { value: "12px" },
          md: { value: "13px" },
          lg: { value: "14px" },
          xl: { value: "16px" },
          "2xl": { value: "20px" },
          "3xl": { value: "24px" },
        },
        letterSpacings: {
          tight: { value: "-0.02em" },
          tighter: { value: "-0.04em" },
          caps: { value: "0.06em" },
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
