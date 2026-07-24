import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";

export default defineConfig({
  root: path.resolve(__dirname, "renderer"),
  plugins: [
    react(),
    electron({
      main: {
        entry: path.resolve(__dirname, "electron/main.ts"),
        vite: {
          build: {
            outDir: path.resolve(__dirname, "dist-electron"),
            rollupOptions: {
              external: ["electron"],
            },
          },
        },
      },
      preload: {
        input: path.resolve(__dirname, "electron/preload.ts"),
        vite: {
          build: {
            outDir: path.resolve(__dirname, "dist-electron"),
          },
        },
      },
      renderer: {},
    }),
  ],
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
});
