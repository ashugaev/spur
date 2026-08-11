import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import { visibleWaitTextPlugin } from "./eslint-rules/no-visible-wait-text.js";

const SPUR_TS_FILES = ["v2/src/**/*.ts"];

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      "**/dist/**",
      "**/dist-server/**",
      "**/node_modules/**",
      "**/.next/**",
      "**/.next-sidecars/**",
      "**/coverage/**",
      "packages/web/next-env.d.ts",
      "packages/web/next.config.js",
      "packages/web/postcss.config.mjs",
      ".claude/worktrees/**",
    ],
  },

  // Base JS rules
  eslint.configs.recommended,

  // TypeScript strict rules
  ...tseslint.configs.strict,

  // Prettier compat (disables formatting rules)
  eslintConfigPrettier,

  // Project-wide rules
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // Security: prevent shell injection patterns
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",

      // Code quality
      "no-console": "warn",
      "no-debugger": "error",
      "no-duplicate-imports": "error",
      "no-template-curly-in-string": "warn",
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always"],

      // TypeScript
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/no-require-imports": "error",
    },
  },

  // Spur uses a stricter type-aware lint pass without adding style-only churn.
  {
    files: SPUR_TS_FILES,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-console": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },

  // Relaxed rules for test files
  {
    files: ["**/*.test.ts", "**/__tests__/**"],
    ignores: ["v2/test/**/*.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },

  // Relaxed rules for Next.js pages/components
  {
    files: ["packages/web/**/*.tsx", "packages/web/**/*.ts"],
    rules: {
      "no-console": "off", // Next.js uses console for server logs
    },
  },

  // Waiting states use animated feedback; static wait copy is inaccessible visual noise.
  {
    files: ["packages/web/src/**/*.tsx", "packages/web/src/**/*.ts"],
    ignores: ["packages/web/src/**/__tests__/**", "packages/web/src/**/*.test.*"],
    plugins: { "spur-web": visibleWaitTextPlugin },
    rules: { "spur-web/no-visible-wait-text": "error" },
  },

  // Scripts directory - Node.js environment
  {
    files: ["scripts/**/*.js", "scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
    rules: {
      "no-console": "off", // Scripts use console for output
    },
  },
);
