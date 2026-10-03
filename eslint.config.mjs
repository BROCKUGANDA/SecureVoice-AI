import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import eslintConfigPrettier from "eslint-config-prettier";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // TypeScript rules
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/prefer-as-const": "off",
      "@typescript-eslint/no-unused-disable-directive": "off",

      // React rules
      "react-hooks/exhaustive-deps": "off",
      "react-hooks/purity": "off",
      "react/no-unescaped-entities": "off",
      "react/display-name": "off",
      "react/prop-types": "off",
      "react-compiler/react-compiler": "off",

      // Next.js rules
      "@next/next/no-img-element": "off",
      "@next/next/no-html-link-for-pages": "off",

      // General JavaScript rules
      "no-unused-vars": "off",
      // Deliberately off, with the count measured at the time of writing. These
      // are not "too much work" reasons, they are signal-to-noise reasons: each
      // one fires far more often on legitimate code than on real defects, so
      // turning them on trains people to ignore the linter.
      //   no-console            216 hits (deliberate operator/CLI logging)
      //   prefer-template        72 hits (string concat is idiomatic here)
      "no-console": "off",
      "prefer-template": "off",
      "no-debugger": "off",
      "no-empty": "off",
      "no-irregular-whitespace": "off",
      "no-case-declarations": "off",
      "no-fallthrough": "off",
      "no-mixed-spaces-and-tabs": "off",
      "no-redeclare": "off",
      "no-undef": "off",
      "no-unreachable": "off",
      "no-useless-escape": "off",

      // ── Enabled rules ────────────────────────────────────────────────────────
      // These were all measured against the tree before being switched on. The
      // zero-count rules are errors because they cost nothing today and catch
      // real defects tomorrow. The three with a small count are warnings so the
      // existing violations are visible in `bun run lint` output instead of
      // blocking a deploy on unrelated churn.
      "no-var": "error", // 0 hits
      "prefer-const": "error", // 0 hits
      eqeqeq: ["warn", "smart"], // 10 hits
      "no-throw-literal": "error", // 0 hits
      "no-return-await": "error", // 0 hits
      "no-useless-concat": "error", // 0 hits
      "prefer-promise-reject-errors": "error",
      "no-async-promise-executor": "error",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ], // 34 hits
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ], // 3 hits
    },
  },
  {
    // Generated + vendored trees that are gitignored. `tool-results/` holds compiled
    // CommonJS output from an earlier tooling run: it is not source, it is not
    // committed, and linting it reported errors on a clean checkout — which trains
    // everyone to ignore `bun run lint` failing. `mini-services/*/node_modules` is
    // excluded for the same reason as the root. `src/generated/` is Prisma ORM
    // v7's client output: regenerable TypeScript that lives under src/ so the
    // bundler can compile it, and just as much an artifact as tool-results/.
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "src/generated/**",
      "examples/**",
      "skills",
      "tool-results/**",
      "mini-services/*/node_modules/**",
      "mini-services/*/.next/**",
      // Gitignored local tool state, but ESLint does not read .gitignore: without
      // these, `bun run lint` fails on .gitnexus/run.cjs's CommonJS requires, which
      // is noise from a directory nobody edits by hand.
      ".gitnexus/**",
      ".coverage/**",
      ".covprobe2/**",
    ],
  },
];

// MUST stay last. eslint-config-prettier switches off every ESLint rule that
// conflicts with Prettier, so anything appended after it would be undone. It
// also has to come after the ignores block above, otherwise the global
// ignores stop applying.
eslintConfig.push(eslintConfigPrettier);

// eslint-config-prettier treats a handful of rules as "special": it switches
// them off by default because they are opinionated rather than
// Prettier-conflicting, and it cannot tell whether you meant to have them.
// eqeqeq is one of them, so it has to be switched back on AFTER the Prettier
// config or it silently never runs.
eslintConfig.push({
  rules: {
    eqeqeq: ["warn", "smart"],
  },
});

export default eslintConfig;
