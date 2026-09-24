// The counterfactual: "what happens to my odds if I stop taking shorts?"
//
// This is the one place a journal FILTER reaches the engine, and it is the most
// dangerous feature in the app, because a segment is always chosen by looking at
// the same trades that then score it. The design review that preceded this
// argued for not building it at all, on the strength of a null experiment:
// journals where every tag is assigned at random and NO segment carries any
// signal by construction still produce a flagged "leak" essentially every time,
// with a median phantom gain of tens of thousands of dollars. The one thing that
// killed all 196 of them was the app's own bar - n>=30 AND an interval on the
// difference that clears zero.
//
// So those two are what these tests pin. They are not decoration on the feature;
// they are the reason it is allowed to exist.
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, futures, twoStep } from "./env.mjs";
import { buildOnce } from "./build.mjs";

installDom();
const J = await import(await buildOnce("counterfactual"));

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

test("the 30-trade floor is a refusal, and it is the same one Validate uses", () => {
  assert.equal(J.CUT_MIN_N, 30, "moving this silently lowers the bar on every counterfactual");
  const cut = Array.from({ length: 20 }, () => -1);
  const at29 = J.cutStat(Array.from({ length: 29 }, () => 1), cut);
  const at30 = J.cutStat(Array.from({ length: 30 }, () => 1), cut);
  assert.equal(at29.enough, false, "29 trades left must not buy an instruction");
  assert.equal(at30.enough, true);
  // the floor is about what is LEFT, not about what is removed
  assert.equal(J.cutStat(Array.from({ length: 200 }, () => 1), [-1, -1]).enough, true);
});

test("the change reported is exactly what leaving them out does to the record", () => {
  const kept = [1, 1, 1, -1, 2, 0, 0.5, -1, 1.5, -1];
  const cut = [-1, -1, -2];
  const c = J.cutStat(kept, cut);
  assert.equal(c.nBase, 13);
  assert.equal(c.nKept, 10);
  assert.equal(c.nCut, 3);
  assert.ok(Math.abs(c.expKept - mean(kept)) < 1e-12);
  assert.ok(Math.abs(c.expBase - mean([...kept, ...cut])) < 1e-12);
  assert.ok(Math.abs(c.d - (mean(kept) - mean([...kept, ...cut]))) < 1e-12,
    "the headline number must be the difference it claims to be");
});

test("cutting nothing changes nothing, and gets no band", () => {
  const rs = [1, -1, 1, -1, 2];
  const c = J.cutStat(rs, []);
  assert.equal(c.d, 0);
  assert.equal(c.dLo, 0);
  assert.equal(c.dHi, 0);
  assert.equal(c.separable, false, "a zero difference is never a finding");
  // and the degenerate other end: cutting everything cannot divide by zero
  const all = J.cutStat([], rs);
  assert.ok(Number.isFinite(all.expKept) && Number.isFinite(all.d));
  assert.equal(all.enough, false);
});

test("the band is deterministic - the same record always gives the same answer", () => {
  const kept = Array.from({ length: 80 }, (_, i) => (i % 3 ? 1 : -1));
  const cut = Array.from({ length: 25 }, (_, i) => (i % 5 ? -1 : 2));
  const a = J.cutStat(kept, cut), b = J.cutStat(kept, cut);
  assert.equal(a.dLo, b.dLo, "a confidence interval that flickered on re-render would be worse than none");
  assert.equal(a.dHi, b.dHi);
  assert.equal(a.separable, b.separable);
});

test("a real, large leak IS called separable, even against a 34-segment scan", () => {
  // 100 trades at +0.4R average, 40 at -1R: not a subtle effect
  const kept = Array.from({ length: 100 }, (_, i) => (i % 2 ? 1.4 : -0.6));
  const cut = Array.from({ length: 40 }, () => -1);
  const c = J.cutStat(kept, cut, 34);
  assert.ok(c.d > 0.2, "leaving out 40 full losers has to move the record, got " + c.d);
  assert.ok(c.dLo > 0, "a positive finding needs the LOW end of the band above zero");
  assert.ok(c.d > c.noise, "and it has to clear the scan's own noise floor (" + c.noise + ")");
  assert.equal(c.separable, true, "band " + c.dLo + " to " + c.dHi + ", noise floor " + c.noise);
});

test("both bars have to be cleared, not either one", () => {
  const kept = Array.from({ length: 100 }, (_, i) => (i % 2 ? 1.4 : -0.6));
  const cut = Array.from({ length: 40 }, () => -1);
  // the same difference, met after scanning an absurd number of segments: the
  // band is unchanged and still clear of zero, but the noise floor rises with
  // the size of the scan and eventually swallows it
  const narrow = J.cutStat(kept, cut, 34), wide = J.cutStat(kept, cut, 400);
  assert.ok(Math.abs(wide.dLo - narrow.dLo) < 1e-12, "the band does not depend on the scan");
  assert.ok(wide.noise > narrow.noise, "but the noise floor does");
  // and it is bounded, or a journal with hundreds of instruments would spend
  // the main thread on the null instead of on the odds
  assert.equal(J.cutStat(kept, cut, 500).noise, J.cutStat(kept, cut, 90000).noise, "K is capped");
});

// ---- the null experiment, in miniature ----
// Every trade is one IID draw. Every "segment" is a random subset, independent
// of outcome by construction, so the true difference is zero for all of them.
// Then the app's own selection rule runs: take the worst-looking segment. The
// naive readout ("expectancy went from +0.10R to +0.28R") fires nearly every
// time. The band on the CHANGE is what has to refuse to call it real.
function nullTrial(seed) {
  const rnd = J.mulberry(seed);
  const N = 130;
  const rs = Array.from({ length: N }, () => (rnd() < 0.45 ? 1.6 : -1));
  // ~34 overlapping subsets, the same order of magnitude as the edge report's
  // families (session, grade, regime, direction, instrument, emotion, mistake)
  const segs = [];
  for (let s = 0; s < 34; s++) {
    const p = 0.08 + (s % 6) * 0.07;            // sizes from ~10 to ~55 trades
    const idx = [];
    for (let i = 0; i < N; i++) if (rnd() < p) idx.push(i);
    if (idx.length < 4 || N - idx.length < J.CUT_MIN_N) continue;
    const sub = idx.map((i) => rs[i]);
    segs.push({ idx: new Set(idx), sub, m: mean(sub) });
  }
  if (!segs.length) return null;
  segs.sort((a, b) => a.m - b.m);
  const worst = segs[0];                         // exactly what the leak table names
  const kept = rs.filter((_, i) => !worst.idx.has(i));
  return {
    // the multiplicity the trader actually faced: every segment on the list
    full: J.cutStat(kept, worst.sub, segs.length),
    // and the same cut scored as though it had been the only hypothesis, which
    // is the band on its own
    bandOnly: J.cutStat(kept, worst.sub, 1),
  };
}

test("on a record where no segment carries signal, the worst-looking cut is not called real", () => {
  let trials = 0, looksLikeAGain = 0, bandOnly = 0, bothBars = 0;
  for (let s = 1; s <= 60; s++) {
    const t = nullTrial(s * 977);
    if (!t) continue;
    trials++;
    if (t.full.d > 0) looksLikeAGain++;
    if (t.bandOnly.separable) bandOnly++;
    if (t.full.separable) bothBars++;
  }
  assert.equal(trials, 60, "the harness itself has to produce trials");
  // 1. the phantom, in full health: a naked difference is a "gain" every time
  assert.equal(looksLikeAGain, 60, "the naive readout looks like free money on every one of these");
  // 2. the bootstrap band alone lets roughly a fifth through - almost exactly
  //    the under-coverage the design review measured (77% against a nominal 90%)
  //    by a completely different route. This is why the band is not the gate.
  assert.ok(bandOnly >= 8 && bandOnly <= 20,
    "the band alone should leak around a fifth of these, got " + bandOnly + "/60");
  // 3. both bars: none. If this ever goes above zero, the noise floor has been
  //    weakened and the app is manufacturing confidence again.
  assert.equal(bothBars, 0, "phantom leaks called real: " + bothBars + "/60");
});

// ---- the survival-cost rule ----
test("a counterfactual cannot be answered without its survival number", () => {
  J.setFirm(twoStep());
  const base = Array.from({ length: 120 }, (_, i) => (i % 3 === 0 ? -1 : i % 3 === 1 ? 1.2 : -0.2));
  const kept = base.filter((r) => r > -0.9);
  const od = J.cutOdds(base, kept, 0.8, 0.6, 300, 150);
  for (const k of ["passBase", "passKept", "survBase", "survKept"]) {
    assert.ok(typeof od[k] === "number" && od[k] >= 0 && od[k] <= 1, k + " must be a probability, got " + od[k]);
  }
  assert.ok(od.passKept > od.passBase, "dropping every full loser has to lift the pass odds");
  assert.ok(od.survKept > od.survBase, "and survival with it, on this construction");
});

test("scoring the counterfactual leaves the engine on the edge it found", () => {
  // withEdge is the whole mechanism; a leaked S.trades would put the WRONG
  // record behind every other tab, silently, for the rest of the session
  J.setFirm(futures());
  const mine = [1, -1, 1, 2, -1];
  J.S.trades = mine;
  J.cutOdds([1, -1, 1, -1], [1, 1], 0.5, 0.5, 60, 40);
  assert.equal(J.S.trades, mine, "S.trades must come back exactly as it was");
  J.S.trades = null;
});

test("a 2-step firm is scored on BOTH phases, the same as every other surface", () => {
  const rs = Array.from({ length: 60 }, (_, i) => (i % 2 ? 1.5 : -1));
  J.setFirm(twoStep());
  const two = J.cutOdds(rs, rs, 0.8, 0.6, 400, 60);
  const st = J.withEdge(rs, () => J.challengeStats(0.8, 400));
  assert.ok(Math.abs(two.passBase - st.both) < 1e-12,
    "a 2-step firm's pass odds are both phases; quoting phase 1 here would read optimistic");
  assert.ok(st.both < st.pass, "sanity: the harness firm really does have a second phase");
});
