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
      fontSize: "14px",
      lineHeight: "1.6",
      WebkitFontSmoothing: "antialiased",
      textRendering: "optimizeLegibility",
    },
    body: { minHeight: "100vh" },
    "button, input, select": { fontFamily: "inherit", fontSize: "inherit", color: "inherit" },
    "::selection": { backgroundColor: "fg", color: "bg" },
    ":focus-visible": { outline: "2px solid var(--colors-accent)", outlineOffset: "2px" },
  },
  theme: {
    extend: {
      tokens: {
        fonts: {
          sans: { value: "'Geist Variable', system-ui, sans-serif" },
          mono: { value: "'Geist Mono Variable', ui-monospace, monospace" },
        },
        fontSizes: {
          xs: { value: "12px" },
          sm: { value: "13px" },
          md: { value: "14px" },
          lg: { value: "16px" },
          xl: { value: "20px" },
          "2xl": { value: "24px" },
          "3xl": { value: "32px" },
        },
        letterSpacings: {
          tight: { value: "-0.02em" },
          tighter: { value: "-0.04em" },
          caps: { value: "0.06em" },
        },
      },
      semanticTokens: {
        colors: {
          bg: pair("#ffffff", "#000000"),
          bgSubtle: pair("#fafafa", "#0a0a0a"),
          bgHover: pair("#f5f5f5", "#141414"),
          border: pair("#ebebeb", "#242424"),
          borderStrong: pair("#c9c9c9", "#454545"),
          fg: pair("#171717", "#ededed"),
          fgMuted: pair("#666666", "#a1a1a1"),
          fgFaint: pair("#8f8f8f", "#707070"),
          accent: pair("#0070f3", "#3291ff"),
          ok: pair("#28a948", "#62c073"),
          warn: pair("#c47600", "#f5a623"),
          danger: pair("#e5484d", "#ff6166"),
        },
      },
    },
  },
});
