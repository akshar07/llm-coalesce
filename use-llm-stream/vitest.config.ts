import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    globals: false,
    setupFiles: ["./test/setup.ts"],
  },
});
