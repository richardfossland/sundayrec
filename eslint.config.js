import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "target",
      "src-tauri/target",
      "src-tauri/gen",
      "reference/**",
      "coverage",
      "node_modules",
    ],
  },

  // The ported legacy Electron renderer (vanilla TS, browser runtime). It is a
  // faithful verbatim copy of a shipped app, so we run the recommended rules but
  // do NOT bikeshed its style: `any` and unused-vars are downgraded so a 1:1 port
  // never fails the lint gate.
  {
    files: ["legacy/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.browser,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Stylistic rules we don't enforce on the verbatim port.
      "no-empty": "off",
      "no-useless-assignment": "off",
      "prefer-const": "off",
    },
  },

  // Config + tooling files (node runtime).
  {
    files: ["*.{js,ts}", "*.config.{js,ts}", "scripts/**/*.{js,mjs}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node,
    },
  },

  prettier,
);
