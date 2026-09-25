// Writes samples/sample-1000-trades.json from src/sample.ts - the same code the
// in-app "Load sample journal" button runs, so the file and the button cannot
// drift apart. The end date is fixed so the file is reproducible byte for byte.
//
//   node scripts/sample.mjs
import * as esbuild from "esbuild";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { installDom } = await import(pathToFileURL(join(root, "tests/unit/env.mjs")).href);
installDom();   // util.ts reads window at import
const out = join(root, "tests/unit/.build/sample.mjs");
mkdirSync(dirname(out), { recursive: true });
await esbuild.build({ entryPoints: [join(root, "src/sample.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" });
const { generateSample } = await import(pathToFileURL(out).href);

const data = generateSample(Date.UTC(2026, 8, 24));
writeFileSync(join(root, "samples/sample-1000-trades.json"), JSON.stringify(data));

const rs = data.trades.map((t) => (t.exit - t.entry) / (t.entry - t.stop));
const dec = rs.filter((r) => Math.abs(r) > 1e-9), w = dec.filter((r) => r > 0);
const sum = (a) => a.reduce((s, v) => s + v, 0);
console.log(data.trades.length + " trades " + data.trades[0].dateTime.slice(0, 10) + " to " + data.trades.at(-1).dateTime.slice(0, 10));
console.log("win rate " + (100 * w.length / dec.length).toFixed(1) + "%  expectancy " + (sum(rs) / rs.length).toFixed(3) + "R  PF " + (sum(w) / -sum(dec.filter((r) => r < 0))).toFixed(2));
