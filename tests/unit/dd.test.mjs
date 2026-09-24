// Forward drawdown, its horizon, and the uncertainty that has to travel with it.
//
// The acceptance numbers below were supplied with the brief and independently
// reproduced here against the real estimator. They are pinned rather than
// described because every one of them is a claim the screen makes to a trader
// about how much money to be ready to lose.
//
// ON TOLERANCES. Two honest sources of slack, and neither is a licence to drift:
//   - The reference population is DISCRETE (51 x +1.735R, 40 x -1R, 10 x 0R), so
//     an attainable drawdown is a - 1.735b for integer a, b. At T=100 the median
//     sits between the atoms 5.000 and 5.265; "5.1" and "5.26" are the same
//     answer with different tie handling, not a disagreement.
//   - A 99th percentile from N pooled paths carries real Monte Carlo error.
// So p50/p90 are held to +/-0.3R and p99 to +/-0.7R (+/-1.0R for the pooled
// double-bootstrap tail). Tightening those means raising the run count, never
// moving the target.
import test from "node:test";
import assert from "node:assert/strict";
import { installDom } from "./env.mjs";
import { buildOnce } from "./build.mjs";

installDom();
const E = await import(await buildOnce("dd"));
const { ddSim, effectiveN, fitBlock, autocorr, overshootProfile, maxRiskForLimit, zFor, wilsonAt } = E;

// The reference record: expectancy +0.48R, per-trade SD ~1.31R
const POP = [...Array(51).fill(1.735), ...Array(40).fill(-1), ...Array(10).fill(0)];
const IID = { method: "iid", block: 1, overshoot: true };
const near = (got, want, tol, what) =>
  assert.ok(Math.abs(got - want) <= tol, what + ": got " + got.toFixed(2) + ", expected " + want + " +/-" + tol);

test("the reference population is the one the acceptance numbers were quoted for", () => {
  assert.equal(POP.length, 101);
  const mean = POP.reduce((a, b) => a + b, 0) / 101;
  const sd = Math.sqrt(POP.reduce((a, b) => a + (b - mean) ** 2, 0) / 100);
  near(mean, 0.48, 0.005, "expectancy");
  near(sd, 1.31, 0.01, "per-trade SD");
});

test("iid bootstrap reproduces the acceptance drawdowns at 100, 500 and 1,000 trades", () => {
  // ONE set of paths, read at three checkpoints. That is not an optimisation:
  // it makes the horizon curve nested by construction, so a 500-trade drawdown
  // can never print BELOW the 100-trade one it contains.
  const r = ddSim(POP, [100, 500, 1000], IID, 1, 60000);
  const at = (h) => r.points.find((p) => p.horizon === h);
  const want = {
    100: { p50: 5.1, p90: 8.0, p99: 11.8 },
    500: { p50: 7.8, p90: 10.8, p99: 14.7 },
    1000: { p50: 9.0, p90: 12.0, p99: 15.9 },
  };
  for (const h of [100, 500, 1000]) {
    const p = at(h), w = want[h];
    near(p.p50, w.p50, 0.3, "T=" + h + " p50");
    near(p.p90, w.p90, 0.3, "T=" + h + " p90");
    near(p.p99, w.p99, 0.7, "T=" + h + " p99");
  }
});

test("drawdown grows with the horizon - which is why quoting one without a horizon is meaningless", () => {
  const r = ddSim(POP, [100, 250, 500, 1000], IID, 1, 20000);
  for (let i = 1; i < r.points.length; i++) {
    for (const k of ["p50", "p75", "p90", "p95", "p99"]) {
      assert.ok(r.points[i][k] >= r.points[i - 1][k] - 1e-9,
        k + " fell from T=" + r.points[i - 1].horizon + " to T=" + r.points[i].horizon +
        " - the checkpoints are prefixes of the same paths, so this is impossible unless they stopped being");
    }
  }
  // and the growth is real, not noise: ~5R over 100 trades becomes ~9R over 1000
  assert.ok(r.points[3].p50 > r.points[0].p50 * 1.5, "the whole point of Issue 1");
});

test("the double bootstrap is wider than the plug-in one, in the tail where it matters", () => {
  // The outer loop resamples the RECORD, which is the parameter uncertainty the
  // win-rate interval on the same screen already reports. Ignoring it is how the
  // panel came to say "your true win rate may be 46%" directly above a drawdown
  // computed at exactly 56%.
  const plug = ddSim(POP, [500], IID, 1, 20000).points[0];
  const dbl = ddSim(POP, [500], IID, 800, 25).points[0];
  near(dbl.p50, 7.8, 0.3, "double p50");
  near(dbl.p90, 12.3, 0.5, "double p90");
  near(dbl.p99, 19.5, 1.0, "double p99");
  assert.ok(dbl.p90 > plug.p90 + 0.5, "parameter uncertainty must widen the 90th, got " + dbl.p90 + " vs " + plug.p90);
  assert.ok(dbl.p99 > plug.p99 + 1, "and the 99th by more, got " + dbl.p99 + " vs " + plug.p99);
  // p50 barely moves - resampling the record is roughly mean-preserving. If a
  // future change makes the MEDIAN jump too, the outer loop has become biased
  // rather than merely uncertain.
});

// ---------------------------------------------------------------------------
// Serial structure
// ---------------------------------------------------------------------------

// the same multiset with the losses bunched: 5 wins, 4 losses, 1 scratch, repeating
function clustered() {
  const w = Array(51).fill(1.735), l = Array(40).fill(-1), s = Array(10).fill(0), out = [];
  while (w.length || l.length || s.length) {
    for (let i = 0; i < 5 && w.length; i++) out.push(w.pop());
    for (let i = 0; i < 4 && l.length; i++) out.push(l.pop());
    if (s.length) out.push(s.pop());
  }
  return out;
}

test("a fitted block length comes from the record, and is 1 when there is nothing to preserve", () => {
  // A shuffled record has no serial structure. Applying a block length to it
  // would manufacture clustered losses that are not in the data - the same sin
  // as ignoring real clustering, pointed the other way.
  const f = fitBlock(POP.slice().sort(() => 0));   // as-given order is arbitrary but not clustered by construction
  const shuffled = [];
  let s = 7;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pool = POP.slice();
  while (pool.length) shuffled.push(pool.splice((rnd() * pool.length) | 0, 1)[0]);
  const fs = fitBlock(shuffled);
  assert.equal(fs.block, 1, "a shuffled record must fit block 1, got " + fs.block + " (rho1 " + fs.rho1.toFixed(3) + ")");
  assert.equal(fs.significant, false);
  void f;
});

test("a clustered record fits a longer block, and block bootstrapping it raises the drawdown", () => {
  const C = clustered();
  const f = fitBlock(C);
  assert.ok(f.rho1 > 0.1, "the fixture really is autocorrelated, rho1 = " + f.rho1.toFixed(3));
  assert.ok(f.block >= 2, "so it must fit a block longer than 1, got " + f.block);
  const iid = ddSim(C, [500], { method: "iid", block: 1, overshoot: true }, 1, 20000).points[0];
  const blk = ddSim(C, [500], { method: "block", block: f.block, overshoot: true }, 1, 20000).points[0];
  for (const k of ["p50", "p75", "p90", "p95", "p99"]) {
    assert.ok(blk[k] >= iid[k] - 1e-9,
      "block " + k + " (" + blk[k].toFixed(2) + ") must not fall below iid (" + iid[k].toFixed(2) + ") on a positively autocorrelated record");
  }
  assert.ok(blk.p90 > iid.p90 + 0.3, "and the gap has to be visible, or the block length is not being applied");
});

test("block length 1 is the iid bootstrap exactly, not merely approximately", () => {
  // One code path, two methods. If these ever diverge, the comparison the panel
  // shows between iid and block is comparing two different simulators.
  const a = ddSim(POP, [200], { method: "iid", block: 1, overshoot: true }, 1, 4000).points[0];
  const b = ddSim(POP, [200], { method: "block", block: 1, overshoot: true }, 1, 4000).points[0];
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// Loser overshoot - measured, never invented
// ---------------------------------------------------------------------------

test("a record whose losses are all exactly -1R has no overshoot to model, and says so", () => {
  const p = overshootProfile(POP);
  assert.equal(p.losses, 40);
  assert.ok(p.degenerate, "all 40 losses sit at -1.00R; there is no realised tail here to resample");
  // ...so switching the model on changes nothing, which is the honest outcome.
  // The finding to report is about the JOURNAL - it is recording planned losses,
  // not fills - not about the drawdown.
  const on = ddSim(POP, [300], { method: "iid", block: 1, overshoot: true }, 1, 6000).points[0];
  const off = ddSim(POP, [300], { method: "iid", block: 1, overshoot: false }, 1, 6000).points[0];
  assert.deepEqual(on, off);
});

test("real losses of varying size raise the drawdown over a clean-stop assumption", () => {
  const varied = POP.map((r, i) => (r < 0 ? -(1 + (i % 5) * 0.25) : r));
  const p = overshootProfile(varied);
  assert.equal(p.degenerate, false, "this record does have a realised loss spread");
  const on = ddSim(varied, [500], { method: "iid", block: 1, overshoot: true }, 1, 20000).points[0];
  const off = ddSim(varied, [500], { method: "iid", block: 1, overshoot: false }, 1, 20000).points[0];
  assert.ok(on.p90 > off.p90, "variable fills must cost more than the clean stop they are averaged to: " +
    on.p90.toFixed(2) + " vs " + off.p90.toFixed(2));
});

// ---------------------------------------------------------------------------
// Effective sample size
// ---------------------------------------------------------------------------

test("independent trades give n_eff = n; clustered ones give less", () => {
  const shuffled = [];
  let s = 91;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pool = POP.slice();
  while (pool.length) shuffled.push(pool.splice((rnd() * pool.length) | 0, 1)[0]);
  const a = effectiveN(shuffled, null);
  assert.ok(a.nEff > shuffled.length * 0.9, "a shuffled record must not be discounted, got " + a.nEff.toFixed(1));
  const b = effectiveN(clustered(), null);
  assert.ok(b.nEff < b.n * 0.85, "a clustered record has fewer independent observations than trades: " +
    b.nEff.toFixed(1) + " of " + b.n);
});

test("trades that share a day are not independent observations, and clustering finds it", () => {
  // ten trading days, and within a day every trade goes the same way - the
  // shape a trader who fires one signal into several accounts actually produces
  const rs = [], days = [];
  for (let d = 0; d < 10; d++) {
    const win = d % 2 === 0;
    for (let k = 0; k < 6; k++) { rs.push(win ? 1.735 : -1); days.push(d); }
  }
  const e = effectiveN(rs, days);
  assert.equal(e.n, 60);
  assert.ok(e.cluster != null && e.cluster < 15,
    "60 trades over 10 perfectly correlated days is nearer 10 observations than 60, got " + (e.cluster || 0).toFixed(1));
  assert.equal(e.basis, "cluster", "and the panel must say WHICH bound is binding");
  assert.ok(e.nEff <= e.serial, "the smaller of the two estimators wins - caution is the only survivable direction");
});

test("n_eff can never exceed n, whatever the autocorrelation does", () => {
  const alt = Array.from({ length: 100 }, (_, i) => (i % 2 ? 1.735 : -1));   // strongly negative rho1
  const e = effectiveN(alt, null);
  assert.ok(autocorr(alt, 1) < -0.5, "the fixture really is anti-correlated");
  assert.ok(e.nEff <= e.n, "claiming more information than trades is not a thing to report, got " + e.nEff);
});

// ---------------------------------------------------------------------------
// The number a prop trader actually needs
// ---------------------------------------------------------------------------

test("max risk per trade is the account limit divided by the drawdown it must fit inside", () => {
  // 12R of p95 drawdown inside a 4% trailing limit is 0.33% a trade. This is an
  // identity, not a simulation: every R figure in this app already scales
  // linearly with risk, so simulating it would only add noise.
  near(maxRiskForLimit(12, 4), 0.3333, 0.0001, "4% / 12R");
  near(maxRiskForLimit(8, 10), 1.25, 0.0001, "10% / 8R");
  assert.equal(maxRiskForLimit(0, 4), null, "no drawdown estimate, no answer");
  assert.equal(maxRiskForLimit(12, 0), null, "no limit, no answer");
});

// ---------------------------------------------------------------------------
// Multiplicity
// ---------------------------------------------------------------------------

test("the multiplicity-adjusted interval widens with every subset tested", () => {
  assert.ok(Math.abs(zFor(0.95) - 1.959964) < 1e-5, "the 95% z must still be the one everyone knows");
  const z1 = zFor(0.95), z5 = zFor(1 - 0.05 / 5), z20 = zFor(1 - 0.05 / 20);
  assert.ok(z5 > z1 && z20 > z5, "more looks, wider interval: " + [z1, z5, z20].map((z) => z.toFixed(3)).join(" -> "));
  near(z5, 2.5758, 0.001, "Bonferroni z at K=5");
  const a = wilsonAt(0.56, 91, 0.95), b = wilsonAt(0.56, 91, 1 - 0.05 / 5);
  assert.ok(b.lo < a.lo && b.hi > a.hi, "and it has to reach the win-rate interval too, not only expectancy");
});

test("wilsonAt at 95% is the interval the rest of the app already prints", () => {
  for (const [p, n] of [[0.56, 91], [1.0, 20], [0.2, 35]]) {
    const mine = wilsonAt(p, n, 0.95), theirs = E.wilson(p, n);
    assert.ok(Math.abs(mine.lo - theirs.lo) < 1e-6 && Math.abs(mine.hi - theirs.hi) < 1e-6,
      "two Wilson implementations must not drift: " + JSON.stringify({ mine, theirs }));
  }
});
