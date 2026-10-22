// The Funded / Decision optimizer (2.19.0): the multi-account simulator and the
// picks every optimization makes. The simulator's one load-bearing claim is
// that copy-trading is EXACT - every account on one shared stream of trades -
// so that is pinned against the single-account engine directly.
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, edge, twoStep } from "./env.mjs";
import { buildOnce } from "./build.mjs";

installDom();
const E = await import(await buildOnce("optimize"));
const { S, setFirm, fundedSim, portfolioSim, mulberry, yearSteps,
  sharesAt, netCurve, pickBalancedAt, pickVelocity, pickMaxNet, pickGoal, ladderSizes, pickPerCount, recommendCount, optSettings, OPT_DEFAULTS } = E;

// a thin edge on the 2-step preset: some accounts die inside a year
const setup = () => { setFirm(twoStep()); S.trades = edge(0.45, 1.6, 200); };

test("one account, no rebuy: the portfolio simulator IS the single-account engine", () => {
  setup();
  const T = yearSteps();
  for (const seed of [11, 22, 33, 44]) {
    const single = fundedSim(0.8, T, mulberry(seed));
    const port = portfolioSim([0.8], T, seed, false, false, 0);
    assert.equal(port.profitPct, single.profit, "same banked profit, seed " + seed);
    assert.equal(port.aliveEnd, single.alive);
    assert.equal(port.allDown, single.alive ? 0 : 1, "one account down = all down");
  }
});

test("copy-trade: equal accounts take identical trades, so they live and die together", () => {
  setup();
  const T = yearSteps();
  let deaths = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const single = fundedSim(0.9, T, mulberry(seed));
    const p = portfolioSim([0.9, 0.9, 0.9], T, seed, false, false, 0);
    assert.equal(p.profitPct, 3 * single.profit);
    assert.equal(p.aliveEnd, 3 * single.alive);
    if (!single.alive) deaths++;
  }
  assert.ok(deaths > 0, "the fixture must kill some accounts or this proves nothing");
});

test("independent accounts: all down at once is rarer than one account dying", () => {
  setup();
  const T = yearSteps();
  let oneDies = 0, allDown = 0;
  for (let seed = 1; seed <= 60; seed++) {
    if (!fundedSim(0.9, T, mulberry(seed)).alive) oneDies++;
    allDown += portfolioSim([0.9, 0.9, 0.9], T, seed, true, false, 0).allDown;
  }
  assert.ok(oneDies > 5, "fixture kills accounts: " + oneDies);
  assert.ok(allDown < oneDies, "three independent accounts all down (" + allDown + ") must be rarer than one dying (" + oneDies + ")");
});

test("a ladder diversifies copy-trading: the small account outlives the big one", () => {
  setup();
  const T = yearSteps();
  let same = 0, ladder = 0;
  for (let seed = 1; seed <= 60; seed++) {
    same += portfolioSim(ladderSizes(0.9, 3, false), T, seed, false, false, 0).allDown;
    ladder += portfolioSim(ladderSizes(0.9, 3, true), T, seed, false, false, 0).allDown;
  }
  assert.ok(ladder < same, "laddered copy-trading all down " + ladder + " vs same-size " + same);
});

test("rebuy: a blown account is replaced and keeps earning on the shared stream", () => {
  setup();
  const T = yearSteps();
  let rebuys = 0, more = 0, n = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const a = portfolioSim([1.2], T, seed, false, false, 0);
    const b = portfolioSim([1.2], T, seed, false, true, 50);
    rebuys += b.rebuys;
    if (!a.aliveEnd) { n++; if (b.profitPct >= a.profitPct) more++; }
  }
  assert.ok(rebuys > 0, "something was replaced");
  assert.equal(more, n, "replacing never banks less than stopping");
});

test("ladder sizes average the base and span 0.7x-1.3x", () => {
  assert.deepEqual(ladderSizes(0.5, 1, true), [0.5]);
  assert.deepEqual(ladderSizes(0.5, 3, false), [0.5, 0.5, 0.5]);
  const l = ladderSizes(1, 3, true);
  assert.deepEqual(l, [0.7, 1, 1.3]);
});

test("shares and net: bars move without re-simulating; ruin costs a replacement", () => {
  const mat = [[0.99, 0.9, 0.8], [0.95, 0.86, 0.7], [0.9, 0.84, 0.6], [0.97, 0.88, 0.9]];
  assert.deepEqual(sharesAt(mat, 0.85), [1, 0.75, 0.25]);
  assert.deepEqual(sharesAt(mat, 0.8), [1, 1, 0.5]);
  assert.deepEqual(netCurve([100, 200, 220], [1, 0.9, 0.5], 40), [100, 196, 200]);
});

test("each optimization picks what it says", () => {
  const surv = [1, 0.98, 0.94, 0.9, 0.86, 0.6];
  const shares = [1, 1, 0.95, 0.85, 0.6, 0];
  // Balanced: largest clearing 85% measured AND in 90% of plausible edges
  assert.equal(pickBalancedAt(surv, shares, 5, 0.85, 0.9), 2);
  // ...a stricter confidence or target moves it down, a looser one up
  assert.equal(pickBalancedAt(surv, shares, 5, 0.85, 0.8), 3);
  assert.equal(pickBalancedAt(surv, shares, 5, 0.97, 0.9), 1);
  // Velocity: most payouts above the floor; ties to the smaller size
  assert.equal(pickVelocity([1, 2, 3, 3, 4, 5], surv, [1, 1, 1, 1, 0.5, 0], 5, 0.75, 0.9), 2);
  // Max net: the top of the net curve, -1 when nothing nets positive
  assert.equal(pickMaxNet([5, 9, 12, 7]), 2);
  assert.equal(pickMaxNet([-3, -1]), -1);
  // Goal: the smallest size within 3% of the best odds; out of reach -> -1
  assert.equal(pickGoal([0.2, 0.6, 0.79, 0.8, 0.5]), 2);
  assert.equal(pickGoal([0.01, 0.04]), -1);
});

test("several accounts: fewest that reach the goal half the time; else the closest", () => {
  const row = (n, base, pGoal, netYear, pAllDown) => ({ n, base, sizes: [base], pGoal, payYear: netYear, netYear, pAllDown, rebuys: 0, aliveEnd: n });
  // per count: the smallest size within 3% of that count's best goal odds
  assert.equal(pickPerCount([row(2, 0.3, 0.5, 1, 0), row(2, 0.4, 0.7, 2, 0), row(2, 0.5, 0.71, 3, 0.1)], 1000, 0.85).base, 0.4);
  // across counts: the fewest accounts at >= 50% odds
  const rows = [row(1, 0.5, 0.2, 1, 0), row(2, 0.4, 0.55, 2, 0), row(3, 0.3, 0.9, 3, 0)];
  assert.equal(recommendCount(rows, 1000).n, 2);
  // none reaches half: the best odds
  assert.equal(recommendCount([row(1, 0.5, 0.1, 1, 0), row(2, 0.4, 0.3, 2, 0)], 1000).n, 2);
  // no goal: best net among those keeping all-down risk under 1 - target
  assert.equal(pickPerCount([row(3, 0.3, 0, 5, 0.05), row(3, 0.6, 0, 9, 0.4)], 0, 0.85).base, 0.3);
});

test("settings: defaults out of the box, garbage clamped", () => {
  localStorage.removeItem("pel_opt");
  assert.deepEqual(optSettings(), OPT_DEFAULTS);
  localStorage.setItem("pel_opt", JSON.stringify({ survTarget: 7, conf: "x", maxAccounts: 99, copy: "yes" }));
  const o = optSettings();
  assert.equal(o.survTarget, 0.99);
  assert.equal(o.conf, OPT_DEFAULTS.conf);
  assert.equal(o.maxAccounts, 10);
  assert.equal(o.copy, OPT_DEFAULTS.copy);
  localStorage.removeItem("pel_opt");
});
