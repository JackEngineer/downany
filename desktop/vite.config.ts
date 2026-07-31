import fs from "node:fs";
import path from "node:path";
import { build as viteBuild, defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";

function buildExtractAssets(): { name: string; closeBundle: () => Promise<void> } {
  return {
    name: "build-extract-assets",
    async closeBundle() {
      const outDir = path.resolve(__dirname, "dist-electron");
      fs.mkdirSync(outDir, { recursive: true });
      fs.copyFileSync(
        path.resolve(__dirname, "electron/extract.html"),
        path.join(outDir, "extract.html"),
      );
      await viteBuild({
        configFile: false,
        build: {
          outDir,
          emptyOutDir: false,
          lib: {
            entry: path.resolve(__dirname, "electron/extractPreload.ts"),
            formats: ["cjs"],
            fileName: () => "extractPreload.js",
          },
          rollupOptions: {
            external: ["electron"],
          },
        },
      });
    },
  };
}

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
          plugins: [buildExtractAssets()],
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
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "renderer/index.html"),
        settings: path.resolve(__dirname, "renderer/settings.html"),
      },
    },
  },
});
