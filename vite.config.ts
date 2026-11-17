import { defineConfig } from "vite-plus";

const ignored = [
  ".git/**",
  ".alchemy/**",
  ".wrangler/**",
  "node_modules/**",
  "dist/**",
  "patches/**",
  "**/styled-system/**",
];

export default defineConfig({
  fmt: { ignorePatterns: [...ignored, "**/*.d.ts"] },
  lint: {
    ignorePatterns: ignored,
    // Oxlint's type-aware rules and type checks run on tsrs (tsrs-lint), which Vite+ ships.
    options: { typeAware: true, typeCheck: true },
    plugins: ["typescript", "unicorn", "oxc"],
    rules: {
      "typescript/await-thenable": "error",
      "typescript/no-array-delete": "error",
      "typescript/no-base-to-string": "error",
      "typescript/no-duplicate-type-constituents": "error",
      "typescript/no-explicit-any": "error",
      "typescript/no-floating-promises": "error",
      "typescript/no-for-in-array": "error",
      "typescript/no-implied-eval": "error",
      "typescript/no-meaningless-void-operator": "error",
      "typescript/no-misused-spread": "error",
      "typescript/no-redundant-type-constituents": "error",
      "typescript/no-unsafe-unary-minus": "error",
      "typescript/no-useless-default-assignment": "error",
      "typescript/require-array-sort-compare": "error",
      "typescript/restrict-template-expressions": "error",
      "typescript/unbound-method": "error",
    },
  },
});
