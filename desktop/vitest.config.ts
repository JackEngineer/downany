import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["electron/**/*.test.ts", "renderer/**/*.test.ts", "renderer/**/*.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
