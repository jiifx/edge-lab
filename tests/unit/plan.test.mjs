// "My firm" - the join between a bound firm and the trader's own record.
//
// Two families of assertion here, and the second one is the reason this file is
// worth its runtime:
//
//   1. The SIZING RULES, now shared with the Simulator. These were lifted out of
//      sim.ts rather than copied, so they are unit-testable for the first time -
//      before this, the only thing standing between "best size" and a profit
//      maximum with survival deleted was a comment and one e2e assertion.
//   2. The CHUNKING INVARIANT. buildPlan slices both curves one grid point per
//      macrotask, which is only legitimate because both seed per RUN index and
//      not per risk index. If anyone ever "optimises" that seeding, the plan
//      silently starts answering a different question from the Funded tab and
//      nothing else in the suite would notice.
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, edge, futures, twoStep } from "./env.mjs";
import { buildOnce } from "./build.mjs";

installDom();
const E = await import(await buildOnce("plan"));
const { S, setFirm, riskGrid, pickFundedSize, pickEvalSize, consWindows, activeGates, buildPlan, firstPayoutPctOf } = E;

const journal = (rs) => { S.trades = rs; };

// ---------------------------------------------------------------------------
// The funded sizing rule
// ---------------------------------------------------------------------------

test("the funded size is the LARGEST size on the flat top, not the most profitable one", () => {
  // profit is flat across indices 2..5 (within 3%); survival falls as size rises
  const prof = [40, 70, 100, 99, 98, 98.5, 80, 50];
  const surv = [0.99, 0.97, 0.95, 0.92, 0.88, 0.86, 0.60, 0.30];
  const p = pickFundedSize(prof, surv);
  assert.equal(p.flat.pk, 2, "the peak is index 2");
  assert.equal(p.flat.lo, 2);
  assert.equal(p.flat.hi, 5);
  // largest inside the plateau still clearing 0.85 - NOT the peak, and not the
  // smallest safe size either
  assert.equal(p.inPlateau, 5);
});

test("when the profit peak is not survivable the rule refuses it and drops below the band", () => {
  // This is commit 3a3e9ec's bug in test form. profitPlateau reads prof[] and
  // nothing used to read surv[], which sits in the same object - so the app
  // recommended sizes where 39 accounts in 100 survived the year.
  const prof = [30, 60, 100, 99, 98];
  const surv = [0.97, 0.90, 0.63, 0.50, 0.39];
  const p = pickFundedSize(prof, surv);
  assert.equal(p.flat.lo, 2, "the flat top starts at the peak");
  assert.equal(p.inPlateau, -1, "nothing inside the plateau clears 85% survival");
  assert.equal(p.anywhere, 1, "the largest survivable size sits below the band");
  // and the argmax - the thing the old code named - is a size this rule rejects
  assert.notEqual(p.anywhere, p.flat.pk);
});

test("a curve where no size survives names nothing at all", () => {
  const p = pickFundedSize([10, 20, 30], [0.4, 0.3, 0.2]);
  assert.equal(p.inPlateau, -1);
  assert.equal(p.anywhere, -1, "there is no honest size to name; the caller must say so");
});

test("an empty curve cannot produce a recommendation", () => {
  const p = pickFundedSize([], []);
  assert.equal(p.inPlateau, -1);
  assert.equal(p.anywhere, -1);
});

// ---------------------------------------------------------------------------
// The eval sizing rule
// ---------------------------------------------------------------------------

const ep = (risk, cost, pass, days) => ({ risk, cost, pass, days, attempts: 1 / Math.max(pass, 0.005) });

test("the eval size is the QUICKEST in the cheap band that still passes 85 in 100", () => {
  // costs 100/101/102 are all within 3% of each other, so the money cannot
  // choose between them - the clock and the washout rate have to
  const pts = [ep(0.1, 260, 0.30, 100), ep(0.5, 101, 0.98, 40), ep(0.9, 100, 0.91, 13), ep(1.3, 102, 0.58, 9), ep(1.7, 300, 0.20, 6)];
  const r = pickEvalSize(pts);
  assert.equal(r.pl.lo, 1);
  assert.equal(r.pl.hi, 3);
  assert.ok(r.barMet, "0.90% clears the bar");
  assert.equal(r.pick, 2, "13 days beats 40 days at equal cost, and 1.3% fails the 85% bar");
});

test("when nothing in the cheap band clears the bar it names the likeliest to land, and says so", () => {
  const pts = [ep(0.1, 400, 0.20, 90), ep(0.5, 100, 0.58, 40), ep(0.9, 101, 0.71, 20), ep(1.3, 102, 0.44, 8)];
  const r = pickEvalSize(pts);
  assert.equal(r.barMet, false);
  assert.equal(r.pick, 2, "0.90% is the likeliest of the three in the band");
  // and NOT the fastest - picking speed here is what makes a monthly firm's
  // flat cost band recommend a size that washes out four times as often
  assert.notEqual(r.pick, 3);
});

// ---------------------------------------------------------------------------
// The consistency window: the user's OWN days, walked the way fundedSim walks
// simulated ones
// ---------------------------------------------------------------------------

test("consWindows closes a window when profit reaches one payout, then resets both counters", () => {
  // needR = 10: days 6+5 close the first window (best 6 of 11 = 55%),
  // days 2+2+2+5 close the second (best 5 of 11 = 45%)
  const days = [6, 5, 2, 2, 2, 5].map((r, i) => ({ day: "d" + i, r }));
  const w = consWindows(days, 10, 50);
  assert.equal(w.windows, 2);
  assert.equal(w.blocked, 1, "only the first window has a day over 50% of its profit");
  assert.ok(Math.abs(w.worst - 6 / 11) < 1e-9);
});

test("a losing day counts against the window rather than being skipped", () => {
  // fundedSim accumulates the day's P&L whatever its sign; dropping the losses
  // would make every trader's best day a smaller share than it really is
  const days = [8, -4, 8].map((r, i) => ({ day: "d" + i, r }));
  const w = consWindows(days, 10, 50);
  assert.equal(w.windows, 1);
  assert.ok(Math.abs(w.worst - 8 / 12) < 1e-9, "12R of profit, not 16R");
  assert.equal(w.blocked, 1);
});

test("a record that never reaches one payout reports no windows rather than a verdict", () => {
  const days = [1, 1, 1].map((r, i) => ({ day: "d" + i, r }));
  const w = consWindows(days, 10, 50);
  assert.equal(w.windows, 0);
  assert.equal(w.blocked, 0);
  // the caller must print "not measurable", never "0 of 0 blocked - you're fine"
});

// ---------------------------------------------------------------------------
// The chunking invariant - load-bearing for buildPlan
// ---------------------------------------------------------------------------

test("both size curves are sliceable: one point at a time equals the whole grid", () => {
  setFirm(futures({ timeLimit: 30 }));
  journal(edge(0.55, 1.5, 60));
  const risks = riskGrid().slice(0, 5);
  const whole = E.fundedCurve(risks, 40, 200);
  const sliced = risks.map((r) => E.fundedCurve([r], 40, 200));
  risks.forEach((_, i) => {
    assert.equal(whole.prof[i], sliced[i].prof[0], "funded profit at grid point " + i);
    assert.equal(whole.surv[i], sliced[i].surv[0], "funded survival at grid point " + i);
  });
  const wholeE = E.challengeCurve(risks, 60);
  const slicedE = risks.map((r) => E.challengeCurve([r], 60)[0]);
  risks.forEach((_, i) => {
    assert.equal(wholeE[i].pass, slicedE[i].pass, "eval pass at grid point " + i);
    assert.equal(wholeE[i].cost, slicedE[i].cost, "eval cost at grid point " + i);
  });
  // If this ever fails, buildPlan's per-macrotask chunking has stopped being
  // free: the plan and the Funded tab would be measuring different markets.
});

test("the risk grid reaches 3.0, which is where every risk slider ends", () => {
  const g = riskGrid();
  assert.ok(g[0] <= 0.1 + 1e-9);
  assert.ok(g[g.length - 1] > 2.9, "the top of the grid was 2.5 once, and the 'your size' marker pinned there");
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

const runPlan = (input) => new Promise((res) => { buildPlan(input, () => {}, res); });

test("a plan against a gated firm names both sizes and measures every gate it carries", async () => {
  const firm = futures({
    account: 50000, p1: 6, maxdd: 4, tpd: 5, split: 90, fee: 150,
    payoutBuffer: 3000, payoutCap: 50, winDays: 5, winAmt: 150,
  });
  assert.deepEqual(activeGates(firm).sort(), ["buffer", "cap%", "windays"]);
  const rs = edge(0.57, 1.4, 80);
  const days = Array.from({ length: 40 }, (_, i) => ({
    day: "2026-06-" + String((i % 28) + 1).padStart(2, "0"),
    r: rs.slice(i * 2, i * 2 + 2).reduce((a, b) => a + b, 0),
  }));
  const plan = await runPlan({ firm, rs, days, phase: "eval", haircut: 0 });

  assert.equal(plan.n, 80);
  assert.ok(plan.expectancy > 0, "the fixture is a positive edge");
  assert.equal(plan.evalStage, "ok");
  assert.ok(plan.evalRisk > 0 && plan.evalRisk <= 3, "an eval size on the grid, got " + plan.evalRisk);
  assert.ok(plan.evalCost > 0);
  assert.ok(plan.fundRisk > 0 && plan.fundRisk <= 3, "a funded size on the grid, got " + plan.fundRisk);

  // NO RECOMMENDATION WITHOUT ITS SURVIVAL COST - the project rule, kept
  // structurally rather than in copy. A named size always carries the number.
  if (plan.fundStage === "ok") {
    assert.ok(plan.fundSurv >= 0.85, "a named funded size must clear the 85% bar, got " + plan.fundSurv);
    assert.ok(plan.peakLo > 0 && plan.peakHi >= plan.peakLo, "the flat top has to be reportable beside it");
  }

  // one row per gate the firm actually carries, and nothing invented
  const keys = plan.gates.map((g) => g.key).sort();
  assert.deepEqual(keys, ["buffer", "cap", "windays"]);
  for (const g of plan.gates) {
    assert.ok(g.rule.length > 0 && g.reading.length > 0, g.key + " must carry both the rule and a reading");
  }
});

test("a payout gate can only lower the odds of a first payout - never raise them", async () => {
  // The mirror of engine.rs's payout_gate_can_only_lower_the_odds, but on the
  // number the PLAN shows. The sign is provable, not measured: until the first
  // withdrawal the equity path is identical whatever the gates say, so a gate can
  // only move the first qualifying moment later, and ruin is absorbing. If this
  // ever goes positive by more than Monte Carlo noise, the leave-one-out
  // attribution is comparing two different sets of price paths and the "what the
  // gates cost you" readout is meaningless.
  const firm = futures({ account: 50000, payoutBuffer: 3000, payoutCap: 50, winDays: 5, winAmt: 150 });
  const rs = edge(0.57, 1.4, 80);
  const days = Array.from({ length: 40 }, (_, i) => ({ day: "d" + i, r: 0.4 }));
  const plan = await runPlan({ firm, rs, days, phase: "eval", haircut: 0 });
  assert.ok(plan.gated);
  assert.ok(plan.paidUngated >= plan.paid - 1e-9,
    "gates off must reach a first payout at least as often: " + plan.paidUngated + " vs " + plan.paid);
  for (const g of plan.gates) {
    if (g.dOdds == null) continue;
    assert.ok(g.dOdds <= 1e-9, g.key + " reads as HELPING the odds (" + g.dOdds + "), which is impossible");
  }
});

test("an instant-funded firm is not sized for an evaluation it does not have", async () => {
  const firm = futures({ instant: true, fee: 329, account: 25000 });
  const rs = edge(0.6, 1.3, 50);
  const plan = await runPlan({ firm, rs, days: [], phase: "eval", haircut: 0 });
  assert.equal(plan.evalStage, "instant");
  assert.equal(plan.evalRisk, 0, "there is no eval size to name");
  assert.ok(plan.fundRisk > 0, "the funded side is still the whole question");
});

test("a funded account's evaluation is history, not a forecast", async () => {
  const firm = futures({ account: 50000 });
  const rs = edge(0.58, 1.3, 60);
  const plan = await runPlan({ firm, rs, days: [], phase: "funded", haircut: 0 });
  assert.equal(plan.evalStage, "done");
  assert.equal(plan.evalCost, 0, "fees already spent must not be forecast again");
});

test("firstPayoutPctOf reads a firm handed in, matching the engine's F-bound version", () => {
  setFirm(futures({ account: 50000, payoutMin: 0 }));
  assert.equal(firstPayoutPctOf({ account: 50000, payoutMin: 0 }), E.firstPayoutPct());
  setFirm(futures({ account: 50000, payoutMin: 5000 }));
  assert.equal(firstPayoutPctOf({ account: 50000, payoutMin: 5000 }), E.firstPayoutPct());
  // 5000 on a 50k account is 10%, which is above the 5% sweep chunk
  assert.equal(firstPayoutPctOf({ account: 50000, payoutMin: 5000 }), 10);
});

test("buildPlan leaves the F and S singletons exactly as it found them", async () => {
  const before = futures({ account: 100000, maxdd: 7, split: 80 });
  setFirm(before);
  journal([1, -1, 1]);
  const snapF = JSON.parse(JSON.stringify(E.F));
  const snapS = S.trades.slice();
  await runPlan({ firm: futures({ account: 25000, maxdd: 3, split: 95 }), rs: edge(0.6, 1.2, 40), days: [], phase: "eval", haircut: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(E.F)), snapF, "a leaked firm re-prices every other tab (Trap #10)");
  assert.deepEqual(S.trades, snapS, "a leaked edge does the same");
});

// ---------------------------------------------------------------------------
// The size band - what "too thin to size" turns into instead of a blank panel
// ---------------------------------------------------------------------------

const {
  PLAN_BAND_MIN_N, PLAN_BAND_DRAWS, bandGrid, bandDraw, sizeFromCurve, bandOf, resampleRecord,
} = E;

test("the band grid is a coarsening of the real grid, never a different one", () => {
  const full = riskGrid(), coarse = bandGrid();
  assert.ok(coarse.length >= 6 && coarse.length < full.length, "coarser, but still a grid: " + coarse.length);
  // every band point must be a REAL grid point - a band drawn over sizes the
  // plan cannot name would be a range around a number that does not exist
  coarse.forEach((r) => assert.ok(full.some((f) => Math.abs(f - r) < 1e-9), r + " is not on the real grid"));
});

test("a band draw is deterministic, so a re-render is not a re-roll", () => {
  const firm = futures({ account: 50000 });
  const rs = edge(0.6, 1.5, 24);
  assert.equal(bandDraw(firm, rs, 11), bandDraw(firm, rs, 11), "same seed, same size");
  const many = new Set(Array.from({ length: 12 }, (_, i) => bandDraw(firm, rs, i)));
  assert.ok(many.size > 1, "different seeds must actually explore, got one value " + [...many]);
});

test("a resampled record with no edge in it contributes 0, not its least-bad size", () => {
  // Trap #21's shape: a number standing in for the absence of one. If a tenth of
  // the records yours could be carry no safe size, the LOW END of the band has
  // to say so - averaging over the possibility hides it.
  const firm = futures({ account: 50000 });
  const dead = Array.from({ length: 30 }, () => -1);
  assert.equal(bandDraw(firm, dead, 3), 0, "a record that only loses names no size at all");
});

test("bandOf keeps its ends in order and bandDraw feeds it real sizes", () => {
  const b = bandOf([0.4, 0.9, 1.2, 2.0, 0.7, 1.1], 0.9);
  assert.ok(b.lo <= b.mid && b.mid <= b.hi, "lo <= mid <= hi");
  assert.equal(b.n, 6);
  assert.equal(bandOf([], 0.9).n, 0, "an empty draw set is n=0, not a band around zero");
});

test("resampling is with replacement and preserves the record's length", () => {
  const rs = edge(0.6, 1.5, 20);
  const d = resampleRecord(rs, 5);
  assert.equal(d.length, rs.length);
  d.forEach((v) => assert.ok(rs.includes(v), "a resample may only contain values the record actually has"));
  assert.deepEqual(resampleRecord(rs, 5), d, "seeded by draw index, so it is stable");
});

test("the band appears only in the window where a single size would be a guess", async () => {
  const firm = futures({ account: 50000, split: 90 });
  const days = Array.from({ length: 12 }, (_, i) => ({ day: "2026-06-" + String(i + 1).padStart(2, "0"), r: 0.5 }));

  const thin = await runPlan({ firm, rs: edge(0.6, 1.5, 22), days, phase: "eval", haircut: 0, curRisk: null });
  assert.ok(thin.sizeBand, "22 trades is inside the band window");
  assert.equal(thin.sizeBand.n, PLAN_BAND_DRAWS, "every draw must land in the band");
  assert.ok(thin.sizeBand.lo <= thin.sizeBand.hi);

  const fat = await runPlan({ firm, rs: edge(0.6, 1.5, 60), days, phase: "eval", haircut: 0, curRisk: null });
  assert.equal(fat.sizeBand, null, "at 60 trades the app names a size and the range would be noise around it");

  const tiny = await runPlan({ firm, rs: edge(0.6, 1.5, PLAN_BAND_MIN_N - 4), days, phase: "eval", haircut: 0, curRisk: null });
  assert.equal(tiny.sizeBand, null, "below the floor not even a range is offered");
});

test("a thinner record produces a wider band - the whole point of printing one", async () => {
  const firm = futures({ account: 50000, split: 90 });
  const days = Array.from({ length: 12 }, (_, i) => ({ day: "d" + i, r: 0.5 }));
  const w = async (n) => {
    const p = await runPlan({ firm, rs: edge(0.6, 1.5, n), days, phase: "eval", haircut: 0, curRisk: null });
    return p.sizeBand.hi - p.sizeBand.lo;
  };
  const narrow = await w(29), wide = await w(12);
  assert.ok(wide >= narrow,
    "12 trades must not claim to know the size better than 29 do (" + wide + " vs " + narrow + ")");
});

// ---------------------------------------------------------------------------
// "At your current size" - a description, which is why it has no n bar at all
// ---------------------------------------------------------------------------

test("the current size is priced when the account has one, and absent when it does not", async () => {
  const firm = futures({ account: 50000, split: 90 });
  const rs = edge(0.6, 1.5, 60);
  const days = Array.from({ length: 20 }, (_, i) => ({ day: "d" + i, r: 0.5 }));

  const none = await runPlan({ firm, rs, days, phase: "eval", haircut: 0, curRisk: null });
  assert.equal(none.curRisk, null, "an R-only account has no size the app can see");
  assert.equal(none.curSurv, 0, "and nothing was simulated for it");

  const at = await runPlan({ firm, rs, days, phase: "eval", haircut: 0, curRisk: 0.5 });
  assert.equal(at.curRisk, 0.5);
  assert.ok(at.curSurv > 0 && at.curSurv <= 1, "survival is a probability, got " + at.curSurv);
  assert.ok(at.curPaid >= 0 && at.curPaid <= 1);
  assert.ok(at.curPaidDays >= 0);
});

test("the current size is priced at ANY n - it describes a choice, it does not recommend one", async () => {
  // The reason My firm is not a blank panel at twelve trades. If this ever
  // starts gating on PLAN_MIN_N the panel goes dark again for exactly the user
  // who needs it: an account that already passed on a short record.
  const firm = futures({ account: 50000, split: 90 });
  const days = Array.from({ length: 6 }, (_, i) => ({ day: "d" + i, r: 0.5 }));
  const p = await runPlan({ firm, rs: edge(0.6, 1.5, 12), days, phase: "eval", haircut: 0, curRisk: 0.5 });
  assert.equal(p.curRisk, 0.5);
  assert.ok(p.curSurv > 0, "twelve trades still price the size you are already trading");
});

test("a funded account skips the evaluation leg entirely, at any n", async () => {
  // The incoherence this release removed: the panel printed "your plan - funded
  // account" and then refused, for a question whose eval leg it was already
  // skipping. evalStage must read "done" whether the record is long or short.
  const firm = twoStep({ account: 50000 });
  const days = Array.from({ length: 8 }, (_, i) => ({ day: "d" + i, r: 0.5 }));
  for (const n of [12, 60]) {
    const p = await runPlan({ firm, rs: edge(0.6, 1.5, n), days, phase: "funded", haircut: 0, curRisk: 0.5 });
    assert.equal(p.evalStage, "done", "at n=" + n + " a funded account's evaluation is history, not a forecast");
    assert.equal(p.evalRisk, 0, "and no eval size is named for it");
  }
});
