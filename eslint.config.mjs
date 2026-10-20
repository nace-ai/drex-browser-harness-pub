// The lint half of the build gate (npm run build runs npm run check first). src/**/*.ts gets typescript-eslint's
// strict type-aware rules; the Node scripts and tests stay JavaScript and get ESLint's recommended rules.
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const unused = { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true };

export default defineConfig([
  globalIgnores([
    "dist/",
    "runner/extension/",
    ".worker-releases/",
    "runs/",
    "eval/.cache/",
    "eval/out/",
    ".worktrees/",
    "third_party/",
    "docs/",
    "e2e/site/",
    "**/__pycache__/",
  ]),
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  js.configs.recommended,
  { rules: { "no-empty": ["error", { allowEmptyCatch: true }], "no-unused-vars": ["error", unused] } }, // best-effort chrome calls ignore failures on purpose
  {
    files: ["src/**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", unused],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }], // counts and prices go into prompts
      "@typescript-eslint/prefer-nullish-coalescing": ["error", { ignorePrimitives: { string: true } }], // "" means missing: keys, page text
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
      "@typescript-eslint/explicit-module-boundary-types": "error", // every export states its contract
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
    },
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: { globals: { ...globals.browser, ...globals.serviceworker, chrome: "readonly" } },
  },
  { files: ["**/*.mjs"], languageOptions: { globals: globals.node } },
  { files: ["test/**/*.mjs"], languageOptions: { globals: { chrome: "writable" } } },
  // the runner's functions that Playwright evaluates in the extension's panel page and in the agent's tab
  {
    files: ["runner/src/run.mjs", "runner/src/worker-transport.mjs"],
    languageOptions: { globals: { ...globals.browser, chrome: "readonly" } },
  },
]);
