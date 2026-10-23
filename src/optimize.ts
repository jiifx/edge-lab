// The Funded / Decision OPTIMIZER: the pure part. Settings with defaults, the
// business arithmetic of an account SLOT, the size each optimization picks, and
// the multi-account summaries. No DOM and no simulation here - sim.ts feeds it
// curves and matrices it already computed, so every pick on the chart, in the
// suggestions table and on the Decision tab comes from one place.
//
// 2.20.0 re-founded this on the economics of running funded accounts as a
// business. A slot is: buy an evaluation, pass, withdraw until the account
// breaches, buy again. What a size is worth is what the slot returns on the
// fees it eats, not what one account banks in one year - that view gave a
// blown account's replacement no income, charged no first purchase, and (with
// the old 5%-a-week withdrawal habit) capped income so that most sizes looked
// the same.
import { LS } from "./util";
import { ROBUST_CONF } from "./plan";
import { setPayModel } from "./engine";

// ---------------------------------------------------------------------------
// settings: one default for each knob, every one configurable, one reset
// ---------------------------------------------------------------------------
export interface OptSettings {
  payMax: boolean;      // withdraw the firm's max each time (else the 5%-a-week habit)
  cushion: boolean;     // size by the distance to the drawdown floor (else fixed %)
  survTarget: number;   // the yearly survival Balanced must clear; 1 - this caps "all down at once"
  conf: number;         // ...in this share of plausible versions of the edge
  maxAccounts: number;  // the accounts you run (1-50): the Several accounts table stars it, Decision plans for it
  maxLifeMonths: number; // the longest an account is followed (fixed: 24) - see optSettings
  copy: boolean;        // several accounts: the same trades on every account
  staggerDays: number;  // several accounts: trading days between buying each one (0 = same day)
  rebuy: boolean;       // several accounts: replace a blown account
}
export const OPT_DEFAULTS: OptSettings = {
  payMax: true, cushion: false, survTarget: 0.9, conf: ROBUST_CONF,
  maxAccounts: 1, maxLifeMonths: 24, copy: true, staggerDays: 0, rebuy: true,
};
const clampN = (v: unknown, lo: number, hi: number, d: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
export function optSettings(): OptSettings {
  const s = LS.get<Partial<OptSettings>>("pel_opt", {}) || {};
  return {
    payMax: bool(s.payMax, OPT_DEFAULTS.payMax),
    cushion: bool(s.cushion, OPT_DEFAULTS.cushion),
    survTarget: clampN(s.survTarget, 0.5, 0.99, OPT_DEFAULTS.survTarget),
    conf: clampN(s.conf, 0.5, 0.99, OPT_DEFAULTS.conf),
    maxAccounts: Math.round(clampN(s.maxAccounts, 1, 50, OPT_DEFAULTS.maxAccounts)),
    // Not a setting since 2.22.1: it only stops the simulation where no breach
    // or move-to-live rule ends an account, and letting it move changed every
    // answer (3 months made almost every size "unbreached") without changing
    // anything real. A value saved by 2.21-2.22.0 is ignored.
    maxLifeMonths: OPT_DEFAULTS.maxLifeMonths,
    copy: bool(s.copy, OPT_DEFAULTS.copy),
    staggerDays: Math.round(clampN(s.staggerDays, 0, 120, OPT_DEFAULTS.staggerDays)),
    rebuy: bool(s.rebuy, OPT_DEFAULTS.rebuy),
  };
}
// The payout and sizing model is read by the ENGINE for every funded number in
// the app (Funded, Decision, the journal's prop odds), so a change here has to
// reach it at once - and at start-up, before anything is computed.
export function applyPayModel() {
  const o = optSettings();
  setPayModel({ payMax: o.payMax, cushion: o.cushion });
}
export function setOpt(patch: Partial<OptSettings>) { LS.set("pel_opt", { ...optSettings(), ...patch }); applyPayModel(); }
export function resetOpt() { LS.set("pel_opt", { ...OPT_DEFAULTS }); applyPayModel(); }
export function isDefault(o: OptSettings): boolean {
  return (Object.keys(OPT_DEFAULTS) as (keyof OptSettings)[]).every((k) => o[k] === OPT_DEFAULTS[k]);
}

// ---------------------------------------------------------------------------
// robustness over plausible versions of the edge
// ---------------------------------------------------------------------------
// mat[draw][size] holds one plausible record's value at that size. Kept as
// values, not hits, so moving a bar in the settings re-picks instantly.
export function sharesAt(mat: number[][], bar: number): number[] {
  if (!mat.length) return [];
  const n = mat[0].length, out = new Array<number>(n).fill(0);
  for (const row of mat) for (let i = 0; i < n; i++) if ((row[i] ?? 0) >= bar) out[i]++;
  return out.map((h) => h / mat.length);
}
// The value a size reaches in at least `conf` of plausible records: the
// (1 - conf) quantile of each column. "At least $3.10 back per $1 in 9 of 10
// versions of your edge" is this at conf 0.9.
export function floorAt(mat: number[][], conf: number): number[] {
  if (!mat.length) return [];
  const n = mat[0].length, out: number[] = [];
  const k = Math.max(0, Math.min(mat.length - 1, Math.floor((1 - conf) * mat.length)));
  for (let i = 0; i < n; i++) out.push(mat.map((r) => r[i] ?? 0).sort((a, b) => a - b)[k]);
  return out;
}

// ---------------------------------------------------------------------------
// the economics of one ACCOUNT, and of the slot it fills
// ---------------------------------------------------------------------------
// An account's life (2.21.0): bought for `costPct` (the expected cost to get
// funded, retries included), `fundSteps` trades to pass, then funded until it
// breaches, moves to live, or the modelled life ends - `life` trades on
// average, withdrawing `prof` in that time. Every ending frees the slot for a
// new account, so the slot's rate is per account over its whole cycle:
//   return    = prof / costPct                          - $ back per $1 of fees
//   per month = (prof - costPct) / (fundSteps + life)   - net, per slot, in time
// No calendar year anywhere: a funded account rarely lives one, and a firm
// that moves accounts to live ends them on its own clock.
// `prof` and `costPct` must share a unit (the curve's % of account, before the
// split, with the cost converted to it), so `roi` is unit-free.
export interface SlotEcon { pay: number; fees: number; net: number; roi: number; months: number; liveMonths: number; perMonth: number }
export function slotEcon(prof: number, life: number, costPct: number, fundSteps: number, stepsPerMonth: number): SlotEcon {
  const c = Math.max(0, costPct), spm = Math.max(1, stepsPerMonth);
  const months = Math.max(1, life + Math.max(0, fundSteps)) / spm;
  const pay = Math.max(0, prof);
  return { pay, fees: c, net: pay - c, roi: c > 0 ? pay / c : 0, months, liveMonths: Math.max(0, life) / spm, perMonth: (pay - c) / months };
}
export function econCurve(prof: number[], life: number[], costPct: number, fundSteps: number, stepsPerMonth: number): SlotEcon[] {
  return prof.map((p, i) => slotEcon(p, life[i] ?? 0, costPct, fundSteps, stepsPerMonth));
}

// ---------------------------------------------------------------------------
// the picks. Each returns an INDEX into the arrays it was given, or -1.
// ---------------------------------------------------------------------------
// The smallest index whose value is within `tol` of the best: neighbouring
// sizes near a flat top differ by sampling noise, so "the" argmax is not an
// answer - the least risk that is as good as the best is.
export function plateauLo(vals: number[], tol = 0.03): number {
  if (!vals.length) return -1;
  let best = 0;
  for (let i = 1; i < vals.length; i++) if (vals[i] > vals[best]) best = i;
  if (!(vals[best] > 0)) return -1;
  const cut = vals[best] * (1 - tol);
  for (let i = 0; i <= best; i++) if (vals[i] >= cut) return i;
  return best;
}
// Max EV (2.22.0): the most expected profit per account after what it cost to
// get funded. That cost does not depend on the FUNDED size, so this is also the
// most $ back per $1 - and it is not the reckless end: an account that blows up
// early stops paying, so over its life the biggest sizes earn less.
export function pickMaxEv(net: number[]): number { return plateauLo(net); }
// The survival levels every sizing table offers, safest first.
export const SURV_PRESETS = [0.99, 0.95, 0.9, 0.8];
// Max payout: with a dollar cap per payout, past some size an account already
// takes the full cap at almost every window and more size only adds risk. The
// least size that gets (within 3%) the most max payouts a funded month.
export function pickMaxPayout(paysMean: number[]): number { return plateauLo(paysMean); }
// Balanced: the largest size up to `upto` that clears `target` at the measured
// edge AND in at least `conf` of plausible records.
export function pickBalancedAt(surv: number[], shares: number[], upto: number, target: number, conf: number): number {
  for (let i = Math.min(upto, shares.length - 1); i >= 0; i--) {
    if ((surv[i] ?? 0) >= target && (shares[i] ?? 0) >= conf) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// several accounts
// ---------------------------------------------------------------------------
export interface PortfolioStat {
  n: number; base: number;
  pay: number;          // mean payouts over the plan window, trader $, all accounts
  fees: number;         // mean fees in it: every account bought + every replacement
  fees95: number;       // fees in a bad run (95th percentile) - the budget to hold
  net: number;          // pay - fees
  roi: number;          // pay / fees
  pAllDown: number;     // share of runs with a moment when NO funded account is up
  rebuys: number;       // mean replacements (breached or moved to live)
}
// In expectation the return per fee dollar does not depend on how many accounts
// run - payouts and fees both scale with the count. What the count changes is
// how often EVERYTHING is down at once, and that is where the size per account
// moves: per count, the best-ROI size among those whose all-down risk stays
// within `allDownMax`. One account must be sized to survive on its own; several
// staggered or independent accounts cover for each other and can run nearer the
// best-ROI size. `ok` is false when no size meets the bar (the safest is shown).
export function pickPerCount(stats: PortfolioStat[], allDownMax: number): { stat: PortfolioStat; ok: boolean } | null {
  if (!stats.length) return null;
  const pool = stats.filter((s) => s.pAllDown <= allDownMax + 1e-9);
  if (!pool.length) return { stat: stats.reduce((a, b) => (b.pAllDown < a.pAllDown ? b : a)), ok: false };
  const i = plateauLo(pool.map((s) => s.roi));
  return { stat: pool[i >= 0 ? i : 0], ok: true };
}
