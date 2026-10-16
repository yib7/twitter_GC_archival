// Flat ESLint config. Correctness-focused (catches undefined refs, redeclares,
// unreachable code, etc.) rather than stylistic — the repo's compact hand-written
// style is intentional, so formatting is left as-is.
const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  {
    ignores: [
      "src/vendor/**",     // vendored Fuse.js + Chart.js (minified)
      "node_modules/**",
      "personal_data*/**",  // private real data + any backup copies (e.g. personal_data.REAL)
      "exports/**",        // raw export stubs (data, not source), gitignored
      "sample/**",         // generated demo data (make-sample.js)
      "**/*.local.js",     // gitignored local overrides
    ],
  },
  js.configs.recommended,
  {
    // Browser app (one IIFE, no modules).
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.browser, Fuse: "readonly", Chart: "readonly" },
    },
    rules: {
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
  {
    // Node CLI scripts + config files (CommonJS).
    files: ["scripts/**/*.js", "*.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: { "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }] },
  },
  {
    // node:test unit tests (and the opt-in big-build test) never touch a page,
    // so they get Node globals only: a stray `document` / `window` there is an error.
    files: ["tests/**/*.test.js", "tests/**/*.big.js"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Playwright specs and their helpers run in Node, but page.evaluate()
    // callbacks reference browser globals.
    files: ["tests/**/*.js"],
    ignores: ["tests/**/*.test.js", "tests/**/*.big.js"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Shared settings and rules for every test file.
    files: ["tests/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
    },
    rules: {
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      // node:test ignores `only` unless --test-only is passed (it isn't,
      // in npm run test:unit), so a committed .only there is silently harmless
      // — but Playwright's forbidOnly (playwright.config.js) only fires in CI,
      // and either way a reviewer scanning a diff should never have to notice
      // a stray `.only` by eye. Fail lint on it everywhere, always.
      //
      // Review fix: no-restricted-properties only matches a simple
      // `Identifier.property` shape (a bare `object` name) — it cannot see
      // `test.describe.only`, because the "object" side of that `.only`
      // access is itself the MemberExpression `test.describe`, not a plain
      // identifier. no-restricted-syntax with an AST selector matches the
      // `.only` MemberExpression directly, regardless of what's on its left,
      // so test.only / describe.only / test.describe.only are all caught.
      "no-restricted-syntax": ["error",
        {
          selector: "MemberExpression[property.name='only']",
          message: "Remove .only before committing — it silently narrows the suite.",
        },
      ],
    },
  },
];
