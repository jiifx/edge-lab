// Inline the built JS into dist/index.html -> one shareable file (browser mode, IndexedDB storage).
import { readFileSync, writeFileSync } from "fs";

let html = readFileSync("dist/index.html", "utf8");
html = html.replace(
  /<script type="module"[^>]*src="\.?\/?(assets\/[^"]+)"[^>]*><\/script>/,
  (_m, p) => '<script type="module">' + readFileSync("dist/" + p, "utf8").replace(/<\/script>/g, "<\\/script>") + "</script>",
);
if (html.includes('src="./assets/')) throw new Error("script tag not inlined");
writeFileSync("dist/EdgeLab.html", html);
console.log("wrote dist/EdgeLab.html", html.length, "bytes");
