import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The MapLibre worker copied in by `predev`/`prebuild`: third-party and
    // minified, and linting it buries our own findings under ~1,000 warnings.
    "public/maplibre/**",
  ]),
]);

export default eslintConfig;
