import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.js"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage/unit",
      reporter: ["text", "json", "json-summary"],
      include: ["app/scripts/**/*.js"],
    },
  },
});
