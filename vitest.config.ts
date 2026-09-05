import { defineConfig } from "vitest/config";

// Host tests are node; inpage and script tests opt into jsdom with a
// `@vitest-environment jsdom` docblock.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    passWithNoTests: true,
  },
});
