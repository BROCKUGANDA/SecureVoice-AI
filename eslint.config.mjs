import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const eslintConfig = [...nextCoreWebVitals, ...nextTypescript, {
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
    "prefer-const": "off",
    "no-unused-vars": "off",
    "no-console": "off",
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
  },
}, {
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
  ]
}];

export default eslintConfig;
