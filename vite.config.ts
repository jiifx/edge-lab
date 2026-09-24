import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    target: "es2020",
    assetsInlineLimit: 100000000, // single-file-ish output: inline everything
  },
  server: { port: 5183, strictPort: true },
  clearScreen: false,
});
