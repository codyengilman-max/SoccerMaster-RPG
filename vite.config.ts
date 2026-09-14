import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // full-match headless runs (~2 s each) back several tactical tests
    testTimeout: 30_000,
  },
});
