import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

export default defineConfig({
  base: "./",
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir: "dist",
    target: "es2020",
    assetsInlineLimit: 100000000, // single-file-ish output: inline everything
  },
  server: { port: 5183, strictPort: true },
  clearScreen: false,
});
