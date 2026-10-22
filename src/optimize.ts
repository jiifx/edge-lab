// The Funded / Decision OPTIMIZER (2.19.0): the pure part. Settings with
// defaults, the size each optimization picks, the net-of-replacement profit
// curve, and the multi-account summaries. No DOM, no engine runs - sim.ts feeds
// it curves and survival matrices it already computed, so every pick on the
// chart, in the suggestions table and on the Decision tab comes from one place.
import { LS } from "./util";
import { SAFE_SURV, ROBUST_CONF } from "./plan";

// ---------------------------------------------------------------------------
// settings: one default for each knob, every one configurable, one reset
// ---------------------------------------------------------------------------
export interface OptSettings {
  survTarget: number;   // the yearly survival the Balanced size must clear
  conf: number;         // ...in this share of plausible versions of the edge
  velFloor: number;     // the survival Velocity may not go below
  maxAccounts: number;  // multi-account: the most accounts to consider
  copy: boolean;        // multi-account: the same trades on every account
  ladder: boolean;      // multi-account: spread sizes 0.7x-1.3x around the base
  rebuy: boolean;       // multi-account: replace a blown account
}
export const OPT_DEFAULTS: OptSettings = {
  survTarget: SAFE_SURV, conf: ROBUST_CONF, velFloor: 0.75,
  maxAccounts: 3, copy: true, ladder: false, rebuy: true,
};
const clampN = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
export function optSettings(): OptSettings {
  const s = LS.get<Partial<OptSettings>>("pel_opt", {}) || {};
  return {
    survTarget: clampN(s.survTarget, 0.5, 0.99, OPT_DEFAULTS.survTarget),
    conf: clampN(s.conf, 0.5, 0.99, OPT_DEFAULTS.conf),
    velFloor: clampN(s.velFloor, 0.3, 0.99, OPT_DEFAULTS.velFloor),
    maxAccounts: Math.round(clampN(s.maxAccounts, 1, 10, OPT_DEFAULTS.maxAccounts)),
    copy: typeof s.copy === "boolean" ? s.copy : OPT_DEFAULTS.copy,
    ladder: typeof s.ladder === "boolean" ? s.ladder : OPT_DEFAULTS.ladder,
    rebuy: typeof s.rebuy === "boolean" ? s.rebuy : OPT_DEFAULTS.rebuy,
  };
}
export function setOpt(patch: Partial<OptSettings>) { LS.set("pel_opt", { ...optSettings(), ...patch }); }
export function resetOpt() { LS.set("pel_opt", { ...OPT_DEFAULTS }); }
export function isDefault(o: OptSettings): boolean {
  return (Object.keys(OPT_DEFAULTS) as (keyof OptSettings)[]).every((k) => o[k] === OPT_DEFAULTS[k]);
}

// ---------------------------------------------------------------------------
// robustness: the share of plausible records clearing a bar, at each size
// ---------------------------------------------------------------------------
// mat[draw][size] holds the survival (or pass rate) one plausible record
// scored at that size. Kept as values, not hits, so moving a bar in the
// settings is instant: no re-simulation.
export function sharesAt(mat: number[][], bar: number): number[] {
  if (!mat.length) return [];
  const n = mat[0].length, out = new Array<number>(n).fill(0);
  for (const row of mat) for (let i = 0; i < n; i++) if ((row[i] ?? 0) >= bar) out[i]++;
  return out.map((h) => h / mat.length);
}

// ---------------------------------------------------------------------------
// net profit: payouts minus the cost of replacing a blown account
// ---------------------------------------------------------------------------
// A year's banked payouts count what an account withdrew BEFORE it died, and
// treat losing it as free - so a size that pays once and blows up read nearly
// as profitable as one that lasts (the "most profit 1.54%" at ~9% survival). An
// account that dies has to be replaced to keep earning, and replacing it costs
// the expected price of getting funded again. Charging that once per death
// makes ruin cost something. `replacePct` is that price in the curve's own
// unit (% of account, before the split), so the curve keeps its scale.
export function netCurve(prof: number[], surv: number[], replacePct: number): number[] {
  return prof.map((p, i) => p - (1 - (surv[i] ?? 0)) * Math.max(0, replacePct));
}

// ---------------------------------------------------------------------------
// the picks. Each returns an INDEX into the arrays it was given, or -1.
// ---------------------------------------------------------------------------
// Balanced: the largest size up to `upto` that clears `target` at the measured
// edge AND in at least `conf` of plausible records.
export function pickBalancedAt(surv: number[], shares: number[], upto: number, target: number, conf: number): number {
  for (let i = Math.min(upto, shares.length - 1); i >= 0; i--) {
    if ((surv[i] ?? 0) >= target && (shares[i] ?? 0) >= conf) return i;
  }
  return -1;
}
// Velocity: the most payouts a year, among sizes up to `upto` whose survival
// stays above the floor (measured, and in `conf` of plausible records). Ties go
// to the smaller size - the same payouts for less risk.
export function pickVelocity(paysMean: number[], surv: number[], sharesFloor: number[], upto: number, floor: number, conf: number): number {
  let best = -1;
  for (let i = 0; i <= Math.min(upto, paysMean.length - 1); i++) {
    if ((surv[i] ?? 0) < floor || (sharesFloor[i] ?? 0) < conf) continue;
    if (best < 0 || paysMean[i] > paysMean[best] + 1e-9) best = i;
  }
  return best;
}
// Max net: the largest net profit. No survival bar - this is the aggressive end,
// shown so the trade-off is visible; the table prints its survival beside it.
export function pickMaxNet(net: number[]): number {
  let best = -1;
  for (let i = 0; i < net.length; i++) if (best < 0 || net[i] > net[best]) best = i;
  return best >= 0 && net[best] > 0 ? best : -1;
}
// Goal: the SMALLEST size whose odds of reaching the goal are within 3% of the
// best odds on the grid (odds under 5% everywhere = out of reach, -1).
export function pickGoal(pHit: number[]): number {
  if (!pHit.length) return -1;
  const best = Math.max(...pHit);
  if (best < 0.05) return -1;
  for (let i = 0; i < pHit.length; i++) if (pHit[i] >= best * 0.97) return i;
  return -1;
}

// ---------------------------------------------------------------------------
// several accounts
// ---------------------------------------------------------------------------
// A ladder spreads the sizes from 0.7x to 1.3x of a base size, averaging the
// base. With copy-trading this is the ONLY diversification there is: the same
// losing streak that ends the biggest account leaves the smaller ones standing.
export function ladderSizes(base: number, n: number, ladder: boolean): number[] {
  if (!ladder || n <= 1) return new Array<number>(n).fill(base);
  return Array.from({ length: n }, (_, k) => Math.round(base * (0.7 + (0.6 * k) / (n - 1)) * 100) / 100);
}
export interface PortfolioStat {
  n: number; base: number; sizes: number[];
  pGoal: number;        // share of years whose payouts reach the goal
  payYear: number;      // mean payouts, trader $ a year
  netYear: number;      // ...minus rebuys x cost to fund
  pAllDown: number;     // share of years with a moment when NO account is up
  rebuys: number;       // mean replacements a year
  aliveEnd: number;     // mean accounts alive at year end
}
// Per account count, the size that reaches the goal with the least risk - the
// same rule as the single-account Goal pick: the smallest base whose goal odds
// are within 3% of that count's best. With no goal: the best net whose
// all-down risk stays under 1 - target.
export function pickPerCount(stats: PortfolioStat[], goal: number, target: number): PortfolioStat | null {
  if (!stats.length) return null;
  if (goal > 0) {
    const best = Math.max(...stats.map((s) => s.pGoal));
    if (best >= 0.05) return stats.find((s) => s.pGoal >= best * 0.97) || null;
    return stats.reduce((a, b) => (b.pGoal > a.pGoal ? b : a));
  }
  const ok = stats.filter((s) => s.pAllDown <= 1 - target);
  const pool = ok.length ? ok : stats;
  return pool.reduce((a, b) => (b.netYear > a.netYear ? b : a));
}
// The recommended setup across counts: with a goal, the FEWEST accounts that
// reach it at least half the time (fewest = least in fees); else the count
// with the best odds. With no goal, the best net.
export function recommendCount(rows: PortfolioStat[], goal: number): PortfolioStat | null {
  if (!rows.length) return null;
  if (goal > 0) {
    const hit = rows.filter((r) => r.pGoal >= 0.5).sort((a, b) => a.n - b.n);
    if (hit.length) return hit[0];
    return rows.reduce((a, b) => (b.pGoal > a.pGoal ? b : a));
  }
  return rows.reduce((a, b) => (b.netYear > a.netYear ? b : a));
}
