// Forward drawdown, and the uncertainty that has to travel with it.
//
// WHAT WAS WRONG. The Validate tab printed "Plan for DD: ~5R typical, ~8R
// rough". Three separate defects in nine characters:
//
//   1. NO HORIZON. The number was maxDD(n, ...) - the drawdown expected over a
//      forward run exactly as long as the record that produced it. On a
//      101-trade journal that is a 101-trade forecast, silently. Max drawdown
//      grows roughly with log(T): the same edge gives 5.1R over 100 trades,
//      7.8R over 500 and 9.0R over 1,000. A drawdown figure with no horizon
//      attached is not a wrong number, it is not a number at all.
//   2. NO PARAMETER UNCERTAINTY. The panel said "your true win rate is between
//      46% and 66%" one line above a drawdown computed as though it were
//      exactly 56%. At the bottom of its own interval the same edge draws 7.5R
//      median and 12.5R at the 90th - not 5.1/8.0.
//   3. A MEDIAN SOLD AS A PLAN. "Typical" is p50. Half of all futures are worse
//      than it by construction, and traders read "plan for DD ~5R" as a budget.
//
// WHAT THIS FILE DOES. One pass of forward walks over a resampled record,
// recording the running maximum drawdown at every checkpoint horizon, under an
// explicit resampling scheme. The checkpoints come out of the SAME paths, so the
// horizon curve is nested by construction: DD over the first 500 trades can
// never print lower than DD over the first 100 of the same path, which is a
// property a per-horizon re-simulation does not have and which shows up as a
// visibly wrong chart the moment sampling noise exceeds the effect.
//
// WHAT IT REFUSES TO DO. It does not invent a fat tail. The overshoot model
// resamples the loss magnitudes the trader actually logged; where every logged
// loss is exactly -1.00R it changes nothing and the readout says so, because
// "your journal records planned losses rather than fills" is the finding there.
import { mulberry } from "./util";

// ---------------------------------------------------------------------------
// Resampling schemes
// ---------------------------------------------------------------------------

export type DDMethod = "iid" | "block";

export interface DDOpts {
  method: DDMethod;
  // mean block length for the stationary bootstrap, in trades. 1 = iid.
  block: number;
  // draw losses at their LOGGED magnitudes (true) or at a clean -1.00R (false).
  // Not a tail the model made up - see the header.
  overshoot: boolean;
}
export const DD_DEFAULT: DDOpts = { method: "block", block: 1, overshoot: true };

// The percentile ladder. p50 is included because hiding it would be its own
// dishonesty, but the UI must label it as the coin flip it is; p90/p99 are the
// sizing anchors. p95 is carried separately for the risk solver.
export interface DDLadder { p50: number; p75: number; p90: number; p95: number; p99: number }
export interface DDPoint extends DDLadder {
  horizon: number;
  // Share of simulated futures whose worst drawdown came in at or under `mark`,
  // when a mark was passed. This is what turns "my worst drawdown was 3.5R" from
  // a floor into a percentile: it answers how lucky that path was, which is the
  // only honest way to read a single realisation of a distribution.
  share?: number;
}

function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[i];
}
function ladder(xs: number[], mark?: number): DDLadder & { share?: number } {
  const s = xs.slice().sort((a, b) => a - b);
  const out: DDLadder & { share?: number } = {
    p50: quantile(s, 0.5), p75: quantile(s, 0.75), p90: quantile(s, 0.9), p95: quantile(s, 0.95), p99: quantile(s, 0.99),
  };
  if (mark != null && s.length) {
    let below = 0;
    for (const x of s) { if (x <= mark + 1e-12) below++; else break; }
    out.share = below / s.length;
  }
  return out;
}

// The loss magnitudes actually logged, as multiples of the average loss. This is
// the "overshoot" distribution and it is MEASURED: a record whose losses all sit
// at exactly -1.00R has no overshoot to model, and the honest thing to report is
// that the journal is recording planned losses rather than realised fills.
export function overshootProfile(rs: number[]): { losses: number; mean: number; p95: number; degenerate: boolean } {
  const mags = rs.filter((r) => r < -1e-9).map((r) => -r);
  if (!mags.length) return { losses: 0, mean: 0, p95: 0, degenerate: true };
  let sum = 0;
  mags.forEach((m) => { sum += m; });
  const avg = sum / mags.length;
  const norm = mags.map((m) => m / avg).sort((a, b) => a - b);
  const spread = norm[norm.length - 1] - norm[0];
  return { losses: mags.length, mean: avg, p95: quantile(norm, 0.95), degenerate: spread < 0.02 };
}

// The clean-stop version of a record: every loss at exactly the average loss
// magnitude, wins and scratches untouched. Turning overshoot OFF resamples this
// instead, so the difference on screen is exactly what variable fills cost.
function flattenLosses(rs: number[]): number[] {
  const p = overshootProfile(rs);
  if (!p.losses) return rs.slice();
  return rs.map((r) => (r < -1e-9 ? -p.mean : r));
}

// ---------------------------------------------------------------------------
// Serial structure
// ---------------------------------------------------------------------------

// Lag-k autocorrelation of the R series, in the order it was traded.
export function autocorr(rs: number[], k: number): number {
  const n = rs.length;
  if (n <= k + 1) return 0;
  let m = 0;
  rs.forEach((r) => { m += r; });
  m /= n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) den += (rs[i] - m) * (rs[i] - m);
  for (let i = 0; i < n - k; i++) num += (rs[i] - m) * (rs[i + k] - m);
  return den > 0 ? num / den : 0;
}

// Mean block length for the stationary bootstrap, FITTED rather than assumed.
//
// A block bootstrap on a record with no serial structure manufactures drawdown
// that is not in the data - which is the same sin as ignoring the structure when
// it is there, pointed the other way. So the block length comes from the record:
// under an AR(1) approximation the integrated autocorrelation time is
// (1+rho)/(1-rho), and that is the length of run the resampler has to keep
// intact to preserve it. A record with rho <= 0 gets block 1, i.e. iid, and the
// UI says the record shows no measurable clustering rather than pretending.
export function fitBlock(rs: number[]): { rho1: number; block: number; se: number; significant: boolean } {
  const n = rs.length;
  const rho1 = autocorr(rs, 1);
  // Bartlett standard error of a sample autocorrelation under the null
  const se = n > 1 ? 1 / Math.sqrt(n) : 1;
  const significant = rho1 > 2 * se;
  if (!significant || rho1 <= 0) return { rho1, block: 1, se, significant: false };
  const tau = (1 + rho1) / (1 - Math.min(0.95, rho1));
  return { rho1, block: Math.max(2, Math.min(20, Math.round(tau))), se, significant: true };
}

// EFFECTIVE SAMPLE SIZE.
//
// "101 trades" is only 101 observations if the trades are independent draws.
// They are not: setups repeat, sessions repeat, several accounts fired the same
// signal, and two positions open at once are one bet. Every interval on the
// Validate screen divides by sqrt(n), so an n that is too big makes every one of
// them too narrow - the screen is then MORE confident than the data, in the one
// place whose entire job is saying how confident to be.
//
// Two estimators, and the smaller one wins because being wrong toward caution is
// the only survivable direction here:
//   serial  - n / (1 + 2*sum rho_k), Geyer's initial-positive-sequence
//             truncation so a noisy tail of autocorrelations cannot inflate it
//   cluster - the survey design effect, n / (1 + (mbar-1)*ICC), over whatever
//             the caller says the clusters are (trading days, by default)
export interface NEff { n: number; nEff: number; serial: number; cluster: number | null; basis: "serial" | "cluster" | "none"; rho1: number; meanCluster: number }
export function effectiveN(rs: number[], clusterOf?: number[] | null): NEff {
  const n = rs.length;
  const rho1 = autocorr(rs, 1);
  // Geyer: sum consecutive lags while the pair sum stays positive
  let sum = 0;
  const maxLag = Math.max(1, Math.min(Math.floor(n / 4), 50));
  for (let k = 1; k + 1 <= maxLag; k += 2) {
    const pair = autocorr(rs, k) + autocorr(rs, k + 1);
    if (pair <= 0) break;
    sum += pair;
  }
  const serial = Math.max(1, Math.min(n, n / (1 + 2 * sum)));

  let cluster: number | null = null;
  let meanCluster = 1;
  if (clusterOf && clusterOf.length === n && n > 1) {
    const groups = new Map<number, number[]>();
    clusterOf.forEach((g, i) => {
      const a = groups.get(g);
      if (a) a.push(rs[i]); else groups.set(g, [rs[i]]);
    });
    const G = groups.size;
    if (G > 1 && G < n) {
      meanCluster = n / G;
      // one-way ANOVA intraclass correlation
      let grand = 0;
      rs.forEach((r) => { grand += r; });
      grand /= n;
      let ssB = 0, ssW = 0;
      groups.forEach((vals) => {
        let m = 0;
        vals.forEach((v) => { m += v; });
        m /= vals.length;
        ssB += vals.length * (m - grand) * (m - grand);
        vals.forEach((v) => { ssW += (v - m) * (v - m); });
      });
      const msB = ssB / (G - 1), msW = ssW / Math.max(1, n - G);
      // the usual unbalanced-design n0
      let sumSq = 0;
      groups.forEach((v) => { sumSq += v.length * v.length; });
      const n0 = (n - sumSq / n) / (G - 1);
      // Guard on the DENOMINATOR, not on msW. Gating this on `msW > 0` reads as
      // defensive and is exactly backwards: zero within-day variance is not "no
      // information about clustering", it is PERFECT clustering - every trade
      // that day did the same thing. It scored ICC 0 and handed back n_eff = n
      // for a record of 60 trades that carried 10 days of information, which is
      // the widest possible version of the bug this whole estimator exists to
      // fix. With msW = 0 the formula gives msB/msB = 1, which is the answer.
      const den = msB + (n0 - 1) * msW;
      const icc = n0 > 0 && den > 0 ? Math.max(0, Math.min(1, (msB - msW) / den)) : 0;
      cluster = Math.max(1, Math.min(n, n / (1 + (meanCluster - 1) * icc)));
    }
  }
  const nEff = cluster != null ? Math.min(serial, cluster) : serial;
  const basis = cluster != null && cluster <= serial ? "cluster" : serial < n - 0.5 ? "serial" : "none";
  return { n, nEff, serial, cluster, basis, rho1, meanCluster };
}

// ---------------------------------------------------------------------------
// The forward simulation
// ---------------------------------------------------------------------------

// One forward path, recording the running maximum drawdown at each checkpoint.
// Checkpoints must be ascending; the result is non-decreasing by construction,
// which is what makes the horizon curve legible rather than a noise band.
function walkDD(series: number[], checkpoints: number[], block: number, rnd: () => number, out: number[][]) {
  const T = checkpoints[checkpoints.length - 1];
  const len = series.length;
  const pRestart = block > 1 ? 1 / block : 1;
  let eq = 0, peak = 0, mx = 0, idx = 0, ci = 0;
  for (let i = 0; i < T; i++) {
    // stationary (Politis-Romano) bootstrap: restart at a uniform position with
    // probability 1/block, otherwise step forward with wraparound. At block = 1
    // every draw restarts, which IS the iid bootstrap - bit-for-bit, so the two
    // methods can be compared without a second code path to keep in step.
    if (pRestart >= 1 || i === 0 || rnd() < pRestart) idx = (rnd() * len) | 0;
    else idx = idx + 1 === len ? 0 : idx + 1;
    eq += series[idx];
    if (eq > peak) peak = eq;
    const d = peak - eq;
    if (d > mx) mx = d;
    while (ci < checkpoints.length && i + 1 === checkpoints[ci]) { out[ci].push(mx); ci++; }
  }
  while (ci < checkpoints.length) { out[ci].push(mx); ci++; }
}

export interface DDResult {
  points: DDPoint[];          // one per checkpoint horizon, ascending
  runs: number;
  method: DDMethod;
  block: number;
  doubleBootstrap: boolean;
}

// THE ESTIMATOR THE PANEL SHOWS.
//
// Double bootstrap, because a drawdown computed from the point estimate answers
// "what if my edge is exactly what I measured", and nobody has that edge. The
// outer loop resamples the RECORD (this is the parameter uncertainty the win-rate
// interval on the same screen is already reporting); the inner loop walks the
// forward horizon from that resample. Pooling the two gives the predictive
// distribution rather than the plug-in one, and the difference is not decoration:
// on the reference 101-trade record it moves the 99th percentile from 14.4R to
// 18.6R at a 500-trade horizon.
//
// Set outer = 1 to get the plain plug-in bootstrap, which is what the acceptance
// numbers for "iid" are quoted against.
// INCREMENTAL, because a 6,000-run sweep to a 2,000-trade horizon is ~24 million
// walk steps and running it in one macrotask made the whole app unclickable for
// a third of a second at a time. `step()` does ONE outer resample and returns
// true when the job is finished, so the caller can spend a slice and yield -
// see runJob in util.ts. ddSim below drives it to completion synchronously,
// which is what the tests and any non-UI caller want.
export interface DDStepper { step: () => boolean; result: () => DDResult }
export function ddJob(rs: number[], checkpoints: number[], opts: DDOpts, outer: number, inner: number, seed = 4801, mark?: number): DDStepper {
  const cps = checkpoints.slice().sort((a, b) => a - b).filter((c) => c > 0);
  const base = opts.overshoot ? rs : flattenLosses(rs);
  const block = opts.method === "block" ? Math.max(1, opts.block) : 1;
  const buckets: number[][] = cps.map(() => []);
  const outerN = Math.max(1, outer), innerN = Math.max(1, inner);
  const empty = !base.length || !cps.length;
  const rnd = mulberry(seed);
  let o = 0;
  return {
    step() {
      if (empty || o >= outerN) return true;
      let series = base;
      if (outer > 1) {
        // resample the record itself. A BLOCK resample here too when the record
        // has serial structure: an iid outer draw would destroy the very
        // clustering the inner walk is being asked to preserve, and the two
        // loops would then disagree about what kind of series this is.
        const rec = new Array<number>(base.length);
        if (block > 1) {
          let idx = 0;
          for (let j = 0; j < base.length; j++) {
            if (j === 0 || rnd() < 1 / block) idx = (rnd() * base.length) | 0;
            else idx = idx + 1 === base.length ? 0 : idx + 1;
            rec[j] = base[idx];
          }
        } else {
          for (let j = 0; j < base.length; j++) rec[j] = base[(rnd() * base.length) | 0];
        }
        series = rec;
      }
      for (let k = 0; k < innerN; k++) walkDD(series, cps, block, rnd, buckets);
      o++;
      return o >= outerN;
    },
    result(): DDResult {
      if (empty) {
        return { points: cps.map((h) => ({ horizon: h, p50: 0, p75: 0, p90: 0, p95: 0, p99: 0 })), runs: 0, method: opts.method, block, doubleBootstrap: outer > 1 };
      }
      return {
        points: cps.map((h, i) => ({ horizon: h, ...ladder(buckets[i], mark) })),
        runs: outerN * innerN,
        method: opts.method, block, doubleBootstrap: outer > 1,
      };
    },
  };
}
export function ddSim(rs: number[], checkpoints: number[], opts: DDOpts, outer: number, inner: number, seed = 4801, mark?: number): DDResult {
  const j = ddJob(rs, checkpoints, opts, outer, inner, seed, mark);
  // eslint-disable-next-line no-empty
  while (!j.step()) { }
  return j.result();
}

// The number a prop trader actually needs: the largest risk-per-trade whose p95
// drawdown still fits inside a hard account limit.
//
// Exact rather than simulated, and it is allowed to be: every R figure in this
// app is already scaled linearly by risk-per-trade, so a drawdown of D R-units
// is D x risk% of the account. Inverting that is division, and simulating it
// would only add noise to an identity.
export function maxRiskForLimit(ddR: number, limitPct: number): number | null {
  if (!(ddR > 0) || !(limitPct > 0)) return null;
  return limitPct / ddR;
}

// Two-sided normal quantile, for the multiplicity adjustment. Acklam's rational
// approximation; |error| < 1.15e-9, which is far past what a displayed interval
// can show. Needed because a Bonferroni-corrected alpha is not one of the three
// z values anyone has memorised, and rounding it would quietly under-widen.
export function zFor(conf: number): number {
  const p = 1 - (1 - conf) / 2;
  if (p <= 0 || p >= 1) return 1.959963985;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q: number, r: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// Wilson interval at an arbitrary confidence, so the multiplicity adjustment can
// reach it. engine.ts's wilson() is the 95% special case of this and stays as
// the app's default; this exists because a Bonferroni-corrected interval has to
// widen the win rate too, not only the expectancy.
export function wilsonAt(p: number, n: number, conf: number): { lo: number; hi: number } {
  if (!(n > 0)) return { lo: 0, hi: 1 };
  const z = zFor(conf), den = 1 + (z * z) / n;
  const rad = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    lo: Math.max(0, (p + (z * z) / (2 * n) - rad) / den),
    hi: Math.min(1, (p + (z * z) / (2 * n) + rad) / den),
  };
}
