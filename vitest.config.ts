import { defineConfig } from "vitest/config";
import { resolveRendererStyles } from "./tools/resolve-renderer-styles.mjs";

export default defineConfig({
  plugins: [
    {
      name: "deepwrite-test-source",
      enforce: "pre",
      resolveId(id) {
        if (id === "virtual:deepwrite-renderer-styles") {
          return "\0virtual:deepwrite-renderer-styles";
        }
        return null;
      },
      load(id) {
        if (id !== "\0virtual:deepwrite-renderer-styles") return null;
        const source = resolveRendererStyles();
        return `export default ${JSON.stringify(source)};`;
      }
    }
  ],
  test: {
    include: [
      "packages/**/*.test.ts",
      "tools/**/*.test.mjs",
      "apps/desktop/src/main/**/*.test.ts",
      "apps/desktop/src/utilities/**/*.test.{ts,mjs}",
      "apps/desktop/src/extras/**/*.test.ts",
      "apps/desktop/src/renderer/**/*.test.ts"
    ],
    environment: "node",
    // The persistence suites commit real project transactions (locks, fsync,
    // rename) against temporary directories. Under the default 5s budget they
    // time out intermittently when many files run in parallel, and the failing
    // file differs run to run. These limits only affect tests that would
    // otherwise hang; they do not make a failing assertion pass.
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
