import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    // Match every test under src — not just src/__tests__. The brain suite
    // lives in src/brain/__tests__ and was silently excluded (148 tests never
    // ran under `npm test`).
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
