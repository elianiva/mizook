import { defineConfig } from "@pandacss/dev";
import { mizookPreset } from "@mizook/design/preset";

export default defineConfig({
  presets: ["@pandacss/preset-base", "@pandacss/preset-panda", mizookPreset],
  include: ["./src/**/*.ts"],
  outdir: "styled-system",
  preflight: true,
});
