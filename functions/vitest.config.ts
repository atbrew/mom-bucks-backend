import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Contract tests (Phase 5) have their own config — they need
    // the Flask stack, Firestore+Auth emulators, and a much higher
    // timeout. They are NOT part of `npm test`; run them via
    // `npm run test:contract` instead.
    exclude: ["test/contract/**", "node_modules/**"],
    environment: "node",
  },
});
