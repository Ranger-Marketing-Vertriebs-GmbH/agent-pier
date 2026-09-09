import js from "@eslint/js";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import react from "eslint-plugin-react-x";
import hooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      "node_modules/**",
      ".cache/**",
      "coverage/**",
      "dist/**",
      ".data/**",
      "vendor/**",
      "test-results/**",
      "playwright-report/**",
      ".superpowers/**",
      ".worktrees/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,jsx}"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrors: "none", varsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-control-regex": "off",
    },
  },
  {
    files: ["web/**/*.{js,jsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: globals.browser,
    },
    plugins: { "react-x": react, "react-hooks": hooks },
    rules: {
      "react-x/no-missing-key": "error",
      "react-x/no-nested-component-definitions": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["tests/**/*.spec.js"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
