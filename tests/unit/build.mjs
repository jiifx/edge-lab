// Bundle the app's modules for Node so the pure functions can be unit-tested
// directly, in milliseconds, instead of only through a browser.
//
// Why a bundle step at all: the source is TypeScript with browser imports, and
// the modules touch window/navigator at import time (util.ts pins devicePixelRatio
// and sniffs the platform). esbuild strips the types; env.mjs supplies just
// enough DOM for the modules to evaluate. Nothing here mocks BEHAVIOUR - every
// function under test runs its real code.
//
// esbuild is used through its Node API rather than the CLI: spawning npx.cmd
// fails outright on Windows without a shell, and the API needs no shell at all.
import * as esbuild from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const outDir = join(here, ".build");
const posix = (p) => p.replace(/\\/g, "/");

let built = null;

// `tag` keeps each test FILE on its own artifact: node --test runs every file in
// its own process, and they would otherwise race writing one app.mjs - a reader
// could import a half-written bundle and see arbitrary exports missing.
export async function buildOnce(tag = "app") {
  if (built) return built;
  mkdirSync(outDir, { recursive: true });
  const src = posix(join(root, "src"));
  // ONE entry re-exporting everything under test, so the S/F singletons are
  // shared between the engine and the tests - two bundles would hand out two
  // copies and every setFirm in a test would silently miss the engine's own F
  const entry = join(outDir, tag + ".entry.ts");
  writeFileSync(entry, [
    `export * from "${src}/engine.ts";`,
    `export * from "${src}/state.ts";`,
    // named rather than `export *`: plan.ts deliberately re-states a couple of
    // the engine's names in a firm-scoped form, and a star re-export would drop
    // the collisions SILENTLY, leaving a test importing undefined
    `export { riskGrid, pickFundedSize, pickEvalSize, consWindows, activeGates, buildPlan, firstPayoutPctOf, PLATEAU_TOL, SAFE_SURV, PASS_BAR, PLAN_MIN_N, PLAN_FUND_SIMS, PLAN_EVAL_SIMS, PLAN_BAND_MIN_N, PLAN_BAND_DRAWS, PLAN_BAND_SIMS, bandGrid, bandDraw, sizeFromCurve, bandOf, bandText, resampleRecord } from "${src}/plan.ts";`,
    `export { ddSim, effectiveN, fitBlock, autocorr, overshootProfile, maxRiskForLimit, zFor, wilsonAt, DD_DEFAULT } from "${src}/dd.ts";`,
    `export { mulberry } from "${src}/util.ts";`,
    `export { stats, statsDeep, fmtDur, excursions, tradeR, trade$, resolvedRs, cutStat, cutOdds, CUT_MIN_N, JMETA } from "${src}/journal.ts";`,
    `export { dowOf, hourOf, hourLabel, durBucket, dayOrdinals, postLossGaps, timeBuckets, separability, dayCountRows, targetSweep } from "${src}/journal.ts";`,
  ].join("\n"));
  const outfile = join(outDir, tag + ".mjs");
  await esbuild.build({
    entryPoints: [entry], bundle: true, format: "esm", platform: "neutral",
    outfile, logLevel: "silent",
  });
  built = "file:///" + posix(outfile);
  return built;
}
