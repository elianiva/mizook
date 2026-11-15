import { recommended } from "@yielded/effect-tsrs/oxlint-presets";
import { defineConfig } from "vite-plus";

const ignored = [
  ".git/**",
  ".alchemy/**",
  ".wrangler/**",
  "node_modules/**",
  "dist/**",
  "patches/**",
];

export default defineConfig({
  fmt: { ignorePatterns: [...ignored, "**/*.d.ts"] },
  lint: {
    ignorePatterns: ignored,
    // `effect-tsrs patch --oxlint` (run by `prepare`) swaps the tsgolint backend for effect-tsrs,
    // so type-aware lint runs only the Effect rules. Types are checked by `tsrs`.
    options: { typeAware: true, typeCheck: false },
    plugins: ["typescript", "unicorn", "oxc", ...recommended.plugins],
    rules: {
      ...recommended.rules,
      // effect-tsrs hands these default type-aware rules to tsgolint. Keep them off.
      "typescript/await-thenable": "off",
      "typescript/no-array-delete": "off",
      "typescript/no-base-to-string": "off",
      "typescript/no-duplicate-type-constituents": "off",
      "typescript/no-floating-promises": "off",
      "typescript/no-for-in-array": "off",
      "typescript/no-implied-eval": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-misused-spread": "off",
      "typescript/no-redundant-type-constituents": "off",
      "typescript/no-unsafe-unary-minus": "off",
      "typescript/no-useless-default-assignment": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "typescript/no-explicit-any": "error",
    },
  },
});
