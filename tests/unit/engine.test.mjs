// Engine invariants. Every assertion here pins a decision that was either
// argued for in a commit message or fixed after an audit found it wrong - the
// point is that a future edit has to argue with a test, not just with a comment.
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, edge, futures, twoStep } from "./env.mjs";
import { buildOnce } from "./build.mjs";

installDom();
const E = await import(await buildOnce("engine"));
const { S, setFirm } = E;

const slider = (p, b, s = 0) => { S.trades = null; S.p = p; S.b = b; S.s = s; };
const journal = (rs) => { S.trades = rs; };

test("sampleR: the three-outcome coin collapses to the old two-outcome one at s=0", () => {
  // the whole reason every pre-2.4.2 anchor survived: same draw, same branch
  slider(0.6, 1.0, 0);
  const seq = [];
  const rnd = E.mulberry ? E.mulberry(12345) : null;
  assert.ok(rnd, "mulberry must be exported for this check");
  for (let i = 0; i < 200; i++) seq.push(E.sampleR(rnd));
  assert.ok(seq.every((r) => r === 1 || r === -1), "no zeros may appear at s=0");
  const wins = seq.filter((r) => r > 0).length;
  assert.ok(Math.abs(wins / 200 - 0.6) < 0.12, "win share should sit near p, got " + wins / 200);
});

test("sampleR: a scratch rate produces exactly that share of zeros, one draw per trade", () => {
  slider(0.6, 1.0, 0.25);
  const rnd = E.mulberry(999);
  const seq = Array.from({ length: 4000 }, () => E.sampleR(rnd));
  const zeros = seq.filter((r) => r === 0).length / 4000;
  assert.ok(Math.abs(zeros - 0.25) < 0.03, "scratch share should be ~25%, got " + zeros);
  const decided = seq.filter((r) => r !== 0);
  const wr = decided.filter((r) => r > 0).length / decided.length;
  assert.ok(Math.abs(wr - 0.6) < 0.04, "p is the DECIDED win rate, got " + wr);
});

test("expectancy dilutes by (1-s); profit factor is scratch-invariant", () => {
  slider(0.55, 1.0, 0);
  const e0 = E.expectancy(), pf0 = E.profitFactor();
  slider(0.55, 1.0, 0.2);
  assert.ok(Math.abs(E.expectancy() - e0 * 0.8) < 1e-12, "expectancy must scale by 1-s");
  assert.ok(Math.abs(E.profitFactor() - pf0) < 1e-12, "PF is gross win / gross loss - the s cancels");
});

test("sigmaR: the three-outcome variance is the real one, not the two-outcome one", () => {
  slider(0.5, 1.0, 0.5);
  // outcomes: +1 w.p. .25, -1 w.p. .25, 0 w.p. .5 -> E=0, E[R^2]=.5, sd=sqrt(.5)
  assert.ok(Math.abs(E.sigmaR() - Math.SQRT1_2) < 1e-9, "got " + E.sigmaR());
});

test("costToFund: a monthly subscription bills continuously, not a month per attempt", () => {
  // the 2.4.3 fix - three quick washouts inside one month are one month of fees
  setFirm(futures({ fee: 49, feeMode: "monthly", activation: 149 }));
  const c = E.costToFund(1 / 3, 6.5);   // 3 attempts, 6.5 days each = 19.5 days
  assert.equal(c.months, 1, "19.5 trading days is one billing month");
  assert.equal(Math.round(c.cost), 49 + 149);
  const slow = E.costToFund(1 / 3, 30); // 90 days total -> 5 months
  assert.equal(slow.months, 5);
  assert.equal(Math.round(slow.cost), 49 * 5 + 149);
});

test("costToFund: one-time fees charge every attempt; a reset price replaces re-attempts", () => {
  setFirm(futures({ fee: 300, feeMode: "once", activation: 0 }));
  assert.equal(Math.round(E.costToFund(0.5, 5).cost), 600, "2 attempts at full price");
  setFirm(futures({ fee: 300, feeMode: "once", activation: 0, resetFee: 100 }));
  assert.equal(Math.round(E.costToFund(0.5, 5).cost), 400, "first full, one reset");
  setFirm(futures({ fee: 300, feeMode: "once", activation: 0, resetFee: 100 }));
  assert.equal(Math.round(E.costToFund(1, 5).cost), 300, "a single attempt never pays a reset");
});

test("costToFund: a hopeless edge caps attempts instead of returning Infinity", () => {
  setFirm(futures({ fee: 100, feeMode: "once", activation: 0 }));
  const c = E.costToFund(0.0001, 5);
  assert.equal(c.attempts, 200);
  assert.ok(isFinite(c.cost));
});

test("firstPayoutPct: the firm's minimum only bites above the trader's own sweep", () => {
  setFirm(futures({ account: 50000, payoutMin: 2000 }));   // 4% < 5% chunk
  assert.equal(E.firstPayoutPct(), 5);
  setFirm(futures({ account: 50000, payoutMin: 5000 }));   // 10% > 5%
  assert.equal(E.firstPayoutPct(), 10);
});

test("ddFloor: static, intraday trailing and EOD trailing are three different rules", () => {
  setFirm(futures({ ddType: "static", maxdd: 4 }));
  assert.equal(E.ddFloor(9, 7, 4), -4, "a static floor never moves");
  setFirm(futures({ ddType: "trailing", ddLock: 0, maxdd: 4 }));
  assert.equal(E.ddFloor(9, 7, 4), 5, "intraday trails the peak TICK");
  setFirm(futures({ ddType: "trailing-eod", ddLock: 0, maxdd: 4 }));
  assert.equal(E.ddFloor(9, 7, 4), 3, "EOD trails the peak CLOSE, so the spike is free");
  setFirm(futures({ ddType: "trailing-eod", ddLock: 1, maxdd: 4 }));
  assert.equal(E.ddFloor(9, 7, 4), 0, "a locked floor stops at break-even");
});

test("evalDays: absent time limit stands in as 500 days, a real one is honoured", () => {
  setFirm(futures({ timeLimit: 0 }));
  assert.equal(E.evalDays(), 500);
  setFirm(futures({ timeLimit: 30 }));
  assert.equal(E.evalDays(), 30);
});

test("the daily loss limit can only lower funded results, and is inert when unreachable", () => {
  journal(edge(0.55, 1.0, 100));
  const run = (daily) => {
    setFirm(futures({ daily }));
    const fs = E.fundedStats(1.0, 400, E.yearSteps());
    return [fs.profit, fs.surv];
  };
  const [p0, s0] = run(0);          // no limit
  const [pU, sU] = run(6);          // 5 trades x 1% can never reach -6%
  assert.ok(Math.abs(pU - p0) < 1e-12 && Math.abs(sU - s0) < 1e-12, "an unreachable limit must be inert");
  let prevP = p0, prevS = s0;
  for (const d of [5, 4, 3, 2, 1]) {
    const [p, s] = run(d);
    assert.ok(p <= prevP + 1e-9, "tighter daily raised profit at " + d);
    assert.ok(s <= prevS + 1e-9, "tighter daily raised survival at " + d);
    prevP = p; prevS = s;
  }
});

test("the first-payout gate can only lower the paid odds; ongoing cadence cannot move them", () => {
  journal(edge(0.52, 1.0, 100));
  const paid = (over) => { setFirm(futures(over)); return E.payoutOdds(1.0, 600, E.yearSteps()).p; };
  const base = paid({});
  assert.ok(Math.abs(paid({ payoutFirst: 5 }) - base) < 1e-12, "a 5-day gate is the sweep habit already");
  let prev = base;
  for (const d of [10, 20, 40, 80]) {
    const v = paid({ payoutFirst: d });
    assert.ok(v <= prev + 1e-9, "a longer wait scored BETTER at " + d);
    prev = v;
  }
  assert.ok(prev < base, "an 80-day wait must cost something");
  assert.ok(Math.abs(paid({ payoutEvery: 30 }) - base) < 1e-12, "spacing between payouts cannot touch the FIRST one");
});

test("payout cadence stays out of the EV entirely", () => {
  journal(edge(0.6, 1.0, 100));
  const profit = (over) => { setFirm(futures(over)); return E.fundedStats(0.5, 400, E.yearSteps()).profit; };
  const base = profit({});
  for (const over of [{ payoutEvery: 21 }, { payoutFirst: 60 }, { payoutMin: 2000 }, { payoutEvery: 30, payoutFirst: 15 }]) {
    assert.ok(Math.abs(profit(over) - base) < 1e-12, "cadence moved the EV: " + JSON.stringify(over));
  }
});

test("withdrawal bookkeeping on an UNLOCKED trailing floor stays pinned", () => {
  // An anchor, not an invariant, and worth saying why: the rule it guards - a
  // withdrawal shifts eq, peak, peakEod and dayStart by the SAME chunk, so the
  // distance to the floor is unchanged - is only observable from outside as the
  // survival it produces. An earlier version clamped peakEod at zero, which made
  // the first sweep silently harsher; a mutation test proved the rest of this
  // suite could not see that, so these two numbers stand in the gap. If they
  // move, the withdrawal accounting changed - decide whether you meant it.
  journal(edge(0.6, 1.0, 100));
  setFirm(futures({ ddType: "trailing-eod", ddLock: 0, maxdd: 6 }));
  // Re-minted when the horizon became a real year (252 trading days x tpd)
  // instead of a flat 750 trades. The rule these guard is unchanged; the numbers
  // moved because the run is now 1,260 trades rather than 750, which is a
  // deliberate correction, not a regression. Previous values: 64.6063 / 0.7212
  // / 61.5187 at the 750-trade horizon.
  const eod = E.fundedStats(0.5, 800, E.yearSteps());
  assert.ok(Math.abs(eod.profit - 97.25) < 0.02, "unlocked EOD profit moved: " + eod.profit);
  assert.ok(Math.abs(eod.surv - 0.5813) < 0.005, "unlocked EOD survival moved: " + eod.surv);
  setFirm(futures({ ddType: "trailing", ddLock: 0, maxdd: 6 }));
  const intra = E.fundedStats(0.5, 800, E.yearSteps());
  assert.ok(Math.abs(intra.profit - 90.1938) < 0.02, "unlocked intraday profit moved: " + intra.profit);
  assert.ok(intra.surv < eod.surv, "an intraday floor must never be kinder than an EOD one");
});

test("payout counts are the profit restated, not a second estimate", () => {
  // The Funded tab shows "payouts / year" beside "profit / year". They are the
  // SAME runs counted two ways - banked profit is always a whole number of
  // PAY_CHUNK withdrawals - so if these ever drift apart, one of them is lying
  // to the user about the same simulation.
  journal(edge(0.6, 1.0, 100));
  setFirm(futures());
  const fs = E.fundedStats(0.5, 800, E.yearSteps());
  assert.ok(Math.abs(fs.paysMean * E.PAY_CHUNK - fs.profit) < 1e-9,
    "mean payouts x chunk must reconstruct mean profit: " + fs.paysMean * E.PAY_CHUNK + " vs " + fs.profit);
  assert.ok(Number.isInteger(fs.paysMed), "a count of withdrawals is a whole number: " + fs.paysMed);
  assert.ok(fs.paysMed >= 0 && fs.paysMean >= 0, "counts cannot be negative");
});

test("counting payouts did not disturb the draw stream", () => {
  // fundedStats grew two return fields. Had counting consumed a draw or reordered
  // the loop, every seeded anchor here AND in src-tauri would shift together and
  // silently - so this re-pins the untouched-stream claim on the same firm the
  // Rust anchors use.
  journal(edge(0.6, 1.0, 100));
  setFirm(futures({ ddType: "trailing-eod", ddLock: 0, maxdd: 6 }));
  const fs = E.fundedStats(0.5, 800, E.yearSteps());
  assert.ok(Math.abs(fs.profit - 97.25) < 0.02, "profit moved: " + fs.profit);
  assert.ok(Math.abs(fs.surv - 0.5813) < 0.005, "survival moved: " + fs.surv);
});

test("banked-before-breach splits the same runs, and did not touch the stream either", () => {
  // The headline profit is a mean over every fate; at low survival it is carried
  // by a minority of long-lived accounts. bankedDeadMed answers the question the
  // likely outcome actually asks - "what does it pay me BEFORE it breaches?" -
  // and it has to be pure bookkeeping over the same runs.
  journal(edge(0.6, 1.0, 100));
  setFirm(futures({ ddType: "trailing-eod", ddLock: 0, maxdd: 6 }));
  const fs = E.fundedStats(0.5, 800, E.yearSteps());
  // the anchors above already re-pin the stream; these pin the new fields
  const chunky = (x) => Math.abs(Math.round(x / E.PAY_CHUNK) * E.PAY_CHUNK - x) < 1e-9;
  assert.ok(chunky(fs.bankedDeadMed), "banked cash is chunk-quantised by construction: " + fs.bankedDeadMed);
  assert.ok(chunky(fs.bankedAliveMed), "same for survivors: " + fs.bankedAliveMed);
  assert.ok(fs.bankedAliveMed >= fs.bankedDeadMed,
    "on a positive edge a survivor banks at least what a breached account got out: " +
    fs.bankedAliveMed + " vs " + fs.bankedDeadMed);
  // the mean must sit between the two fate-medians' reach on this record - a
  // gross bookkeeping error (wrong array, wrong sort) lands outside instantly
  assert.ok(fs.bankedDeadMed <= fs.profit || fs.bankedAliveMed <= fs.profit,
    "the overall mean cannot exceed both fate medians on a right-skewed record");
  // no dead runs -> the dead median is 0, not NaN: a firm nobody can breach
  setFirm(futures({ ddType: "static", maxdd: 90, daily: 0 }));
  const safe = E.fundedStats(0.1, 200, E.yearSteps());
  assert.ok(safe.surv > 0.99, "harness: this firm is meant to be unbreachable, surv " + safe.surv);
  assert.equal(safe.bankedDeadMed, 0, "no breached runs -> 0, never NaN");
});

test("a year is a year, and stays one when trades-per-day changes", () => {
  // The bug this pins: the horizon used to be a flat 750 TRADES, so "per year"
  // spanned 750 trading days at 1 trade/day and 75 at 10 - a 10x range under one
  // label - and profit came out bit-identical across it, which cannot be true of
  // trading ten times as often for the same calendar year.
  journal(edge(0.6, 1.0, 100));
  const seen = [];
  for (const tpd of [1, 3, 5, 10]) {
    setFirm(futures({ tpd }));
    const days = E.yearSteps() / tpd;
    assert.equal(days, 252, "a year must be 252 trading days at tpd=" + tpd);
    seen.push(E.fundedStats(0.5, 300, E.yearSteps()).profit);
  }
  // more trades inside the same year must produce more, not the same
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] > seen[i - 1] * 1.05,
      "trading more often in one year must pay more: " + JSON.stringify(seen));
  }
});

test("the profit plateau is NOT flat in survival - a size recommendation must read both", () => {
  // The Funded tab's "Best size" was a pure profit maximum: profitPlateau reads
  // prof and nothing read surv, though both come out of one fundedCurve call.
  // This pins the fact that made that unsafe - inside a plateau where profit is
  // flat to 3% by construction, survival is NOT, so picking on profit alone
  // silently spends risk of ruin. If this ever stops holding, the survival
  // constraint in renderFunded has become a no-op and should be re-justified.
  journal(edge(0.53, 1.15, 200));                       // a thin, realistic edge
  setFirm(futures({ account: 50000, maxdd: 10, ddType: "static", p1: 10, daily: 5, tpd: 5 }));
  const risks = [];
  for (let r = 0.1; r <= 3.0001; r += 0.12) risks.push(r);
  const c = E.fundedCurve(risks, 300, E.yearSteps());
  const pl = E.profitPlateau(c.prof, 0.03);
  // profit really is flat across it - that part of the doctrine is sound
  for (let i = pl.lo; i <= pl.hi; i++) {
    assert.ok(c.prof[i] >= c.prof[pl.pk] * 0.97 - 1e-9, "plateau member below tolerance at " + i);
  }
  // survival is not, somewhere on the grid: there exists a smaller size that
  // survives materially better than the profit peak
  const survAtPeak = c.surv[pl.pk];
  let better = -1;
  for (let i = 0; i < pl.pk; i++) if (c.surv[i] >= survAtPeak + 0.1) { better = i; break; }
  assert.ok(better >= 0,
    "expected a smaller size surviving 10pp better than the profit peak (peak surv " + survAtPeak + ")");
  // and it must still pay something - otherwise "size down" would be empty advice
  assert.ok(c.prof[better] > 0, "the safer size must still be profitable");
});

test("profitPlateau reports the flat top, and degenerates safely", () => {
  const flat = E.profitPlateau([1, 5, 10, 10.1, 10, 5, 1], 0.03);
  assert.equal(flat.pk, 3);
  assert.equal(flat.lo, 2, "0.03 tolerance should reach the 10 on the left");
  assert.equal(flat.hi, 4);
  const allZero = E.profitPlateau([0, 0, 0], 0.03);
  assert.equal(allZero.lo, 0);
  assert.equal(allZero.hi, 2, "an all-zero curve spans everything - the UI must gate on it, not this");
  const one = E.profitPlateau([7], 0.03);
  assert.deepEqual([one.pk, one.lo, one.hi], [0, 0, 0]);
});

test("costPlateau finds the CHEAPEST band, and negation would not have", () => {
  // 97 is the minimum; 100 is within 3.09% of it (97 / 0.97) so it joins the
  // band, 103 does not. Contiguous from the minimum outwards, same as the
  // profit side.
  const p = E.costPlateau([100, 97, 103], 0.03);
  assert.equal(p.pk, 1, "the cheapest point");
  assert.equal(p.lo, 0, "100 is within the multiplicative band of 97");
  assert.equal(p.hi, 1, "103 is not");
  // exact ties keep the LEFTMOST index, which on a risk grid is the smallest
  // size - the conservative end of a genuinely flat bottom
  assert.equal(E.costPlateau([50, 50, 50], 0.03).pk, 0);
  // and the reason it is not a negation: profitPlateau's band is pk*(1-tol),
  // which on negative numbers asks for a cost BELOW the cheapest, so every
  // negated cost curve collapses to a single point and the "band" is a lie
  const negated = E.profitPlateau([100, 97, 103].map((c) => -c), 0.03);
  assert.deepEqual([negated.lo, negated.hi], [1, 1],
    "if this ever stops degenerating, the reciprocal in costPlateau can be simplified");
});

test("challengeStats still runs ONE shared stream - the curve refactor moved nothing", () => {
  // challengeStats and challengeCurve now share a body with the seeding lifted
  // out. challengeStats' numbers are the Decision tab's EV and the Firms table's
  // cost column, so they had to come through that refactor bit for bit. These
  // values were minted from the code BEFORE it, and verified identical after
  // across 48 firm x edge x size cases on all eleven returned fields.
  journal(edge(0.5, 1.6, 200));
  setFirm(twoStep());
  const st = E.challengeStats(0.75, 2600);
  assert.equal(st.pass, 0.9953846153846154);
  assert.equal(st.both, 0.9896153846153846);
  assert.equal(st.meanDaysAll, 15.884230769230768);
  assert.equal(st.meanFailDays, 14.296296296296296);
  assert.equal(st.medDays, 14);
  const big = E.challengeStats(1.5, 2600);
  assert.equal(big.pass, 0.7626923076923077);
  assert.equal(big.both, 0.6473076923076924);
  assert.equal(big.dl, 0.2230769230769231);
});

test("the two phases are reported separately, and the seven outcomes account for every attempt", () => {
  // The Challenge tab used to show ONE end-to-end figure with no way to see which
  // gate was costing the attempts, and its outcome chart plotted phase 1 only -
  // so a run that cleared phase 1 and then breached in phase 2 was painted in the
  // "pass" bar and its cause of death appeared nowhere. These fields are what the
  // per-phase ladder and that chart read.
  journal(edge(0.5, 1.6, 200));
  setFirm(twoStep());
  const st = E.challengeStats(1.5, 2600);   // a size that really does kill attempts
  // 1. nothing is lost: every attempt ends in exactly one of seven ways
  const total = st.both + st.dd + st.dl + st.to + st.dd2 + st.dl2 + st.to2;
  assert.ok(Math.abs(total - 1) < 1e-12, "the terminal outcomes must sum to 1, got " + total);
  // 2. the phase-2 fields are shares of ALL attempts, and phase 1's are unchanged
  assert.ok(Math.abs(st.pass - (st.both + st.dd2 + st.dl2 + st.to2)) < 1e-12,
    "everything that cleared phase 1 either cleared phase 2 or died in it");
  // 3. pass2 is the CONDITIONAL rate, not a share of N - the product is the headline
  assert.ok(Math.abs(st.pass * st.pass2 - st.both) < 1e-12,
    "phase 1 x phase 2 must reproduce the end-to-end number exactly");
  // 4. and the split is not decorative: at this size phase 2 must actually claim
  //    attempts, or the fixture proves nothing about the counters
  assert.ok(st.dd2 + st.dl2 + st.to2 > 0.01,
    "the fixture must kill some attempts IN phase 2 or this test cannot fail");
  assert.ok(st.pass2 < 1, "and pass2 must be a measured rate, not a constant 1");
  // 5. a single-gate firm has an empty second phase - no phantom rows
  setFirm(futures());
  const one = E.challengeStats(1.0, 600);
  assert.equal(one.dd2 + one.dl2 + one.to2, 0, "a 1-phase firm cannot fail a phase 2");
  assert.equal(one.pass2, one.pass > 0 ? 1 : 0, "with no second gate, reaching the end IS passing");
});

test("evalPass is the ONE end-to-end selector - phase 1 is never the firm's odds", () => {
  // This selector was written out at six call sites and the audit triage flagged
  // it as a genuine duplication. The failure it guards is silent: a copy that
  // reads `pass` on a 2-step firm quotes the first gate as the whole evaluation.
  journal(edge(0.5, 1.6, 200));
  const two = twoStep();
  setFirm(two);
  const st = E.challengeStats(1.5, 2600);
  assert.ok(st.both < st.pass, "sanity: this fixture's second phase must cost something");
  assert.equal(E.evalPass(st), st.both, "a 2-step firm is scored on BOTH phases");
  const f1 = futures();
  setFirm(f1);
  const one = E.challengeStats(1.0, 600);
  assert.equal(E.evalPass(one, f1), one.pass, "a 1-phase firm has nothing to multiply");
  // a "2step" firm with the second target zeroed is a one-phase firm, and the
  // engine already treats it as one (phaseWalk is never called a second time) -
  // the guard exists so the selector agrees with the walk rather than reading a
  // `both` that was only ever a copy of `pass`
  const zeroed = twoStep({ p2: 0 });
  setFirm(zeroed);
  const z = E.challengeStats(1.5, 600);
  assert.equal(z.both, z.pass, "with no second target there is no second phase");
  assert.equal(E.evalPass(z, zeroed), z.pass);
});

test("the cheapest eval size is not always the smallest - a clock reverses the advice", () => {
  // Three screens used to end on "lower the eval risk" with no number. This is
  // the case that makes that instruction wrong: under a time limit a smaller
  // size is slower, so attempts run out of room before they reach the target,
  // the pass rate collapses and the expected cost to fund EXPLODES. Same edge,
  // same firm, the only difference being whether a clock is running.
  journal(edge(0.5, 1.6, 200));
  const risks = [];
  for (let r = 0.1; r <= 3.0001; r += 0.12) risks.push(r);

  setFirm(twoStep({ timeLimit: 30 }));
  const clocked = E.challengeCurve(risks, 400);
  const cp = E.costPlateau(clocked.map((p) => p.cost), 0.03);
  assert.ok(cp.pk > 0, "with a 30-day limit the cheapest size must not be the floor");
  assert.ok(clocked[0].cost > clocked[cp.pk].cost * 10,
    "sizing down to the floor should cost an order of magnitude MORE, not less (floor $" +
    Math.round(clocked[0].cost) + " vs cheapest $" + Math.round(clocked[cp.pk].cost) + ")");
  assert.ok(clocked[0].pass < 0.05, "no attempt reaches the target inside 30 days at 0.1%");

  // the control: strip the clock and the old advice becomes correct again,
  // which is exactly why it has to be measured per firm instead of asserted
  setFirm(twoStep());
  const free = E.challengeCurve(risks, 400);
  const fp = E.costPlateau(free.map((p) => p.cost), 0.03);
  assert.equal(fp.pk, 0, "with no time limit the floor really is the cheapest size");
  assert.ok(free[0].pass > 0.95, "and it passes almost always, just slowly");
  assert.ok(free[0].days > free[fp.hi].days,
    "the floor's cost is its time, and that is the column the tile has to show");
});

test("challengeCurve seeds per run, so neighbouring eval sizes are comparable", () => {
  journal(edge(0.5, 1.6, 200));
  setFirm(twoStep({ timeLimit: 30 }));
  const a = E.challengeCurve([0.5, 0.7, 0.9], 300);
  const b = E.challengeCurve([0.5, 0.7, 0.9], 300);
  assert.deepEqual(a.map((p) => p.cost), b.map((p) => p.cost), "the curve must be deterministic");
  // catches the coarse regression: ONE stream running across the whole sweep,
  // where the second 0.7 would inherit whatever draws the first one left behind
  const dup = E.challengeCurve([0.7, 0.7], 300);
  assert.equal(dup[0].pass, dup[1].pass, "identical sizes must replay identical attempts");
  assert.equal(dup[0].cost, dup[1].cost);
  // and catches the SUBTLE one, which the duplicate check above cannot see: a
  // fresh stream per size, shared across the runs inside it. That is exactly what
  // challengeStats does, and it is the thing this estimator exists not to do - a
  // run that washes out a day earlier shifts every later run onto different
  // draws, and the reshuffle is bigger than the difference between two sizes.
  // Compared on a single-phase firm so both estimators report the same field;
  // run 0 sees the same seed either way, so the difference is runs 1..N-1.
  setFirm(futures({ timeLimit: 30 }));
  const shared = E.challengeStats(0.7, 300).pass;
  const curve = E.challengeCurve([0.7], 300)[0].pass;
  assert.notEqual(curve, shared,
    "challengeCurve is reading challengeStats' shared stream - the per-run seeding is gone");
});

test("a firm nobody can pass produces a flat cost curve, not a cheapest size", () => {
  // costToFund caps a hopeless edge at 200 attempts rather than dividing by
  // zero, so an unpassable firm gives a FLAT curve at the cap - and a flat curve
  // has a "cheapest" point like any other. The UI has to gate on the pass rate,
  // which means the pass rate has to actually be zero here.
  journal(edge(0.5, 1.6, 200));
  setFirm(twoStep({ minDays: 20, timeLimit: 10 }));   // arithmetically unsatisfiable
  const pts = E.challengeCurve([0.25, 0.75, 1.5, 2.5], 200);
  pts.forEach((p) => assert.equal(p.pass, 0, "no size can pass at risk " + p.risk));
  const costs = pts.map((p) => p.cost);
  assert.ok(costs.every((c) => c === costs[0]), "every size hits the same attempts cap");
});

test("fundedCurve uses common random numbers, so neighbouring sizes are comparable", () => {
  journal(edge(0.6, 1.0, 100));
  setFirm(futures());
  const risks = [0.5, 0.6, 0.7];
  const a = E.fundedCurve(risks, 200, E.yearSteps());
  const b = E.fundedCurve(risks, 200, E.yearSteps());
  assert.deepEqual(a.prof, b.prof, "the curve must be deterministic");
  // the same risk asked for twice in one call must give the same answer
  const dup = E.fundedCurve([0.5, 0.5], 200, E.yearSteps());
  assert.equal(dup.prof[0], dup.prof[1], "identical sizes must replay identical paths");
  // The raw payout samples ride the same common random numbers. The payout goal
  // reads them per size, so a reshuffle would make P(hit the goal) wander between
  // neighbouring sizes for reasons that are not the size.
  assert.deepEqual(a.pays, b.pays, "payout samples must be deterministic too");
  assert.deepEqual(dup.pays[0], dup.pays[1], "identical sizes must bank identically");
  risks.forEach((_, i) => {
    const mean = a.pays[i].reduce((x, y) => x + y, 0) / a.pays[i].length;
    assert.ok(Math.abs(mean * E.PAY_CHUNK - a.prof[i]) < 1e-9,
      "per-size payout samples must reconstruct that size's profit at index " + i);
  });
});

test("portfolio: identical accounts are one bet, different rules genuinely separate", () => {
  journal(edge(0.55, 1.0, 100));
  const same = E.portfolioEval([
    { firm: futures(), risk: 0.75 },
    { firm: futures(), risk: 0.75 },
  ], 600);
  assert.equal(same.dist[1], 0, "two identical accounts can never split");
  assert.ok(Math.abs(same.any - same.all) < 1e-12, "all-or-none");
  assert.ok(same.indepAny > same.any + 0.05, "independence must overstate a correlated book");
  const mixed = E.portfolioEval([
    { firm: futures(), risk: 0.75 },
    { firm: twoStep(), risk: 0.75 },
  ], 600);
  assert.ok(mixed.dist[1] > 0.1, "different rule sets must put real mass on 'one of them'");
});

test("portfolio: expected payout is the sum of the parts, correlation or not", () => {
  journal(edge(0.6, 1.0, 100));
  const one = E.portfolioFunded([{ firm: futures(), risk: 0.5 }], 400, E.yearSteps());
  const two = E.portfolioFunded([
    { firm: futures(), risk: 0.5 },
    { firm: futures(), risk: 0.5 },
  ], 400, E.yearSteps());
  assert.ok(Math.abs(two.payout - 2 * one.payout) < 1e-9, "expectation is linear - correlation cannot change it");
  assert.ok(Math.abs(two.survAll - one.survMarg[0]) < 1e-12, "identical accounts survive together");
});

test("computeR: shorts keep their signs, and a missing risk basis is refused", () => {
  const shortWin = { entry: 100, stop: 105, exit: 92, direction: "short" };
  assert.ok(Math.abs(E.computeRraw(shortWin) - 1.6) < 1e-9, "got " + E.computeRraw(shortWin));
  const shortLoss = { entry: 100, stop: 105, exit: 105, direction: "short" };
  assert.equal(E.computeRraw(shortLoss), -1);
  assert.equal(E.computeRraw({ riskAmt: 100, pnl: -250 }), -2.5);
  assert.equal(E.hasRBasis({ pnl: 50 }), false, "a P&L alone is not a risk basis");
  assert.equal(E.hasRBasis({ riskAmt: 100, pnl: 50 }), true);
  assert.equal(E.hasRBasis({ entry: 100, stop: 99, exit: 101 }), true);
  assert.equal(E.hasRBasis({ entry: 100, stop: 100, exit: 101 }), false, "a zero-width stop is no basis");
  // the sign fallback still colours a row, it just must not claim to be a measurement
  assert.equal(E.computeRraw({ pnl: 50 }), 1);
  assert.equal(E.computeRraw({ pnl: -50 }), -1);
});

test("plannedRR: a target below entry is a positive RR on a short", () => {
  assert.ok(Math.abs(E.plannedRR({ entry: 100, stop: 105, target: 90, direction: "short" }) - 2) < 1e-9);
  assert.ok(Math.abs(E.plannedRR({ entry: 100, stop: 95, target: 110, direction: "long" }) - 2) < 1e-9);
  assert.equal(E.plannedRR({ entry: 100, stop: 100, target: 110 }), null, "no stop width, no planned RR");
});

test("payout gates: off is identical, on can only delay the first payout", () => {
  // The 2.8.0 gates (buffer / cap / winning days) ride the provable-sign
  // argument that lets the first-payout leg price gate fields at all: each can
  // only push the first qualifying moment later, and ruin is absorbing.
  journal(edge(0.52, 1.0, 100));
  const odds = (over) => {
    setFirm(futures({ ddType: "trailing-eod", ddLock: 1, ...over }));
    return E.payoutOdds(1.0, 1500, 750).p;
  };
  const base = odds({});
  assert.ok(Math.abs(odds({ payoutBuffer: 0, payoutCap: 0, winDays: 0, winAmt: 0 }) - base) < 1e-12,
    "zeroed gates must be the ungated number exactly");
  let prev = base;
  for (const buf of [1000, 3000, 6000, 12000]) {
    const v = odds({ payoutBuffer: buf });
    assert.ok(v <= prev + 1e-9, "a bigger buffer must never score better: " + buf + " gave " + v);
    prev = v;
  }
  assert.ok(prev < base, "a 24%-of-account buffer must bite");
  let prevC = base;
  for (const cap of [80, 50, 25]) {
    const v = odds({ payoutCap: cap });
    assert.ok(v <= prevC + 1e-9, "a tighter cap must never score better: " + cap + " gave " + v);
    prevC = v;
  }
  assert.ok(prevC < base, "a 25% cap must bite");
  let prevW = base;
  for (const wd of [3, 5, 10]) {
    const v = odds({ winDays: wd, winAmt: 150 });
    assert.ok(v <= prevW + 1e-9, "more winning days must never score better: " + wd + " gave " + v);
    prevW = v;
  }
  assert.ok(prevW < base, "10 winning days of $150 must bite");
});

test("payout gates in the cash-flow: the cap binds per sweep, and pays counts real sweeps", () => {
  // NO direction is asserted on banked cash, and that is a FINDING, not a
  // shortcut: writing this test with "a cap can only shrink what leaves"
  // produced 72.5 vs 70 the other way. A capped trader takes whatever the cap
  // allows at every window; the uncapped habit idles until a full 5% chunk is
  // affordable - so a cap can genuinely bank MORE inside a year by sweeping
  // earlier and oftener, while net worth stays path-identical. The provable
  // sign lives only in the FIRST-payout leg (previous test). What this pins is
  // the mechanics: the cap really binds, no single sweep exceeds the chunk,
  // and the withdrawal count is a real count.
  // 0.1% risk so the cap BINDS: equity at the first window is ~2.5% of
  // account, and 50% of that is under the 5% chunk. At 1% risk equity reaches
  // 25% before the first sweep and the cap would be inert.
  journal(edge(1.0, 1.0, 10));
  setFirm(futures({ ddType: "static", ddLock: 1 }));
  const f0 = E.fundedStats(0.1, 200, 750);
  setFirm(futures({ ddType: "static", ddLock: 1, payoutCap: 50 }));
  const f50 = E.fundedStats(0.1, 200, 750);
  assert.ok(Math.abs(f50.profit - f0.profit) > 1e-9, "at a binding size the cap must move the cash-flow");
  assert.ok(f50.profit > 0, "and it must still pay something");
  // ungated: every sweep is exactly one chunk, so the two counts agree
  assert.ok(Math.abs(f0.paysMean * E.PAY_CHUNK - f0.profit) < 1e-9,
    "ungated pays x chunk must still reconstruct profit exactly");
  // gated: sweeps are capped BELOW the chunk, so count x chunk bounds banked
  // from above and the two no longer coincide
  assert.ok(f50.paysMean * E.PAY_CHUNK > f50.profit + 1e-9,
    "capped sweeps are smaller than a chunk, so count x chunk must exceed banked: " +
    f50.paysMean * E.PAY_CHUNK + " vs " + f50.profit);
  assert.ok(Number.isInteger(f50.paysMed), "a count of withdrawals is a whole number");
});

test("the consistency payout gate only delays, and resets after a payout", () => {
  // 9 of 23 catalogued firms gate withdrawals on "no single day may exceed N%
  // of the profit since your last payout". It is a DELAY, not a failure: a big
  // day blocks requests until later profit dilutes its share. So it keeps the
  // provable sign the first-payout leg rests on, and zeroed it must be the
  // ungated number to the last bit.
  journal(edge(0.52, 1.0, 100));
  const odds = (over) => {
    setFirm(futures({ ddType: "trailing-eod", ddLock: 1, ...over }));
    return E.payoutOdds(1.0, 1500, 750).p;
  };
  const base = odds({});
  assert.ok(Math.abs(odds({ payoutCons: 0 }) - base) < 1e-12, "a zeroed gate must be bit-identical to no gate");
  assert.ok(Math.abs(odds({ payoutCons: 100 }) - base) < 1e-12, "100% can never bind - one day cannot exceed the whole");
  let prev = base;
  for (const c of [60, 40, 25, 15]) {
    const v = odds({ payoutCons: c });
    assert.ok(v <= prev + 1e-9, "a tighter consistency rule scored BETTER at " + c + "%: " + v + " vs " + prev);
    prev = v;
  }
  assert.ok(prev < base, "a 15% rule must bite: " + prev + " vs " + base);

  // and in the cash-flow: the tally resets per payout, so a gate that blocks
  // the FIRST payout cannot block every later one for the same big day
  journal(edge(0.6, 1.2, 100));
  setFirm(futures({ ddType: "static", ddLock: 1, daily: 0 }));
  const f0 = E.fundedStats(0.5, 300, E.yearSteps());
  setFirm(futures({ ddType: "static", ddLock: 1, daily: 0, payoutCons: 30 }));
  const fc = E.fundedStats(0.5, 300, E.yearSteps());
  assert.ok(fc.paysMean <= f0.paysMean + 1e-9, "a consistency gate cannot produce MORE withdrawals: " + fc.paysMean + " vs " + f0.paysMean);
  assert.ok(fc.paysMean > 0, "but it must not block every payout forever - the tally resets");
});

// ---------------------------------------------------------------------------
// Trades-per-day is a loop bound
// ---------------------------------------------------------------------------

test("an absurd trades-per-day cannot ask the engine for an unbounded walk", () => {
  // Reported from the field: a user typed 10,000,000 into Trades per day. That
  // asked phaseWalk for a five-billion-element path array - the renderer died
  // with Out of Memory - and asked every "year" for 2.5 billion steps. Because
  // the firm is persisted, the next launch reloaded the same value and died
  // again, so the app could only be recovered by clearing storage by hand.
  //
  // The clamp lives in the engine, not only in the input, because a firm also
  // arrives from saved presets, restored state, imports and account bindings.
  E.setFirm(futures({ tpd: 10000000 }));
  assert.equal(E.tpdOf(), E.TPD_MAX, "tpd must clamp on read");
  assert.equal(E.F.tpd, E.TPD_MAX, "...and setFirm must heal the stored value, or it lies dormant in localStorage");
  assert.ok(E.yearSteps() <= 252 * E.TPD_MAX, "a year cannot exceed the clamp: " + E.yearSteps());

  // and the walk actually terminates, quickly, with a bounded path
  journal(edge(0.55, 1.5, 40));
  const t0 = Date.now();
  const w = E.phaseWalk(6, 0.5, E.mulberry(1), true);
  assert.ok(Date.now() - t0 < 2000, "a single walk must not take seconds");
  assert.ok(w.path.length <= 500 * E.TPD_MAX + 1,
    "the recorded path must be bounded by the clamp, got " + w.path.length);
});

test("a negative or zero trades-per-day still walks, at one trade a day", () => {
  for (const bad of [0, -5, NaN]) {
    E.setFirm(futures({ tpd: bad }));
    assert.equal(E.tpdOf(), 1, "tpd " + bad + " must floor at 1, not stall or divide by zero");
    assert.equal(E.yearSteps(), 252);
  }
});

test("clamping tpd moves no number at any setting the app actually ships", () => {
  // Every preset and every catalogue firm uses 5. If the clamp changed anything
  // there, it would have moved every anchored figure in the app.
  for (const t of [1, 2, 5, 10, 20]) {
    E.setFirm(futures({ tpd: t }));
    assert.equal(E.tpdOf(), t, "tpd " + t + " must pass through untouched");
  }
});

test("no firm field, however absurd, can produce a non-terminating simulation", () => {
  // The generalisation of the trades-per-day crash. A `max` on an input is a
  // suggestion to a mouse; a firm also reaches F from saved presets, restored
  // state, imported backups and account bindings. This hammers every numeric
  // field with values no form would offer and asserts the engine still returns,
  // quickly, with finite numbers - which is the property that was missing.
  const FIELDS = ["account", "p1", "p2", "maxdd", "ddLock", "daily", "minDays", "cons",
    "tpd", "split", "fee", "timeLimit", "activation", "payoutMin", "payoutEvery",
    "payoutFirst", "payoutBuffer", "payoutCap", "payoutCapAmt", "payoutCons",
    "winDays", "winAmt", "resetFee"];
  const NASTY = [1e9, 1e18, -1e9, 0, NaN, Infinity, -Infinity, 0.5];
  journal(edge(0.55, 1.5, 40));
  for (const f of FIELDS) {
    for (const v of NASTY) {
      E.setFirm(futures({ [f]: v }));
      const t0 = Date.now();
      const st = E.challengeStats(0.5, 60);
      const fs = E.fundedStats(0.5, 30, E.yearSteps());
      const po = E.payoutOdds(0.5, 30, E.yearSteps());
      const ms = Date.now() - t0;
      assert.ok(ms < 3000, f + "=" + v + " took " + ms + "ms - a user input is bounding a loop");
      for (const [name, x] of [["pass", st.pass], ["surv", fs.surv], ["profit", fs.profit], ["paid", po.p]]) {
        assert.ok(isFinite(x), f + "=" + v + " made " + name + " non-finite (" + x + ")");
      }
      // and the walk budget itself must stay bounded whatever was typed
      assert.ok(E.yearSteps() <= 252 * E.TPD_MAX, f + "=" + v + " blew the year budget: " + E.yearSteps());
      assert.ok(E.evalDays() <= 500, f + "=" + v + " blew the eval budget: " + E.evalDays());
    }
  }
});

test("clampFirm heals a poisoned saved firm instead of propagating it", () => {
  // localStorage is not trusted input. A firm written by a hand-edit, a corrupted
  // sync or an older build must come back inside its domain, because the value
  // that bricked the app was one that had already been persisted.
  const poisoned = E.clampFirm({
    account: -5, p1: 1e9, maxdd: 0, tpd: 1e7, split: 4000, minDays: 2.7,
    timeLimit: NaN, payoutCap: 900, winDays: Infinity,
  });
  assert.equal(poisoned.tpd, 20, "tpd clamps to the loop bound");
  assert.equal(poisoned.account, 100, "a negative account is not an account");
  assert.equal(poisoned.split, 100, "a 4000% split is not a split");
  assert.equal(poisoned.minDays, 3, "day counts are integers");
  assert.equal(poisoned.timeLimit, 0, "NaN falls to the bottom of the domain, never through it");
  assert.equal(poisoned.payoutCap, 100);
  assert.equal(poisoned.winDays, 365);
  assert.ok(poisoned.maxdd > 0, "a zero drawdown floor would divide by nothing");
});

test("an R past R_MAX is not a measurement: it is excluded like a trade with no stop", () => {
  const { hasRBasis, R_MAX } = E;
  assert.equal(R_MAX, 1000);
  assert.equal(hasRBasis({ R: 999, Rmanual: true }), true);
  assert.equal(hasRBasis({ R: 1e308, Rmanual: true }), false);
  assert.equal(hasRBasis({ R: -5000, Rmanual: true }), false);
  // a stop a hair off the entry derives R ~ 500,000
  assert.equal(hasRBasis({ entry: 100, stop: 99.99999, exit: 105 }), false);
  assert.equal(hasRBasis({ entry: 100, stop: 99, exit: 105 }), true);
  // an extra zero in Risk $ the other way (P&L 250 on a $0.10 risk)
  assert.equal(hasRBasis({ riskAmt: 0.1, pnl: 250 }), false);
});
