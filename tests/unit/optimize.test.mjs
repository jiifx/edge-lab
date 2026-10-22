// The Funded / Decision optimizer (2.20.0): the payout and sizing model in the
// engine, the multi-account simulator, the economics of an account slot and the
// picks. The simulator's load-bearing claim is that copy-trading is EXACT -
// every account on one shared stream of trades - so that is pinned against the
// single-account engine directly.
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, edge, twoStep, futures } from "./env.mjs";
import { buildOnce } from "./build.mjs";

installDom();
const E = await import(await buildOnce("optimize"));
const { S, setFirm, fundedSim, fundedStats, portfolioSim, mulberry, yearSteps, setPayModel, payModel, maxPayNeed, tpdOf,
  sharesAt, floorAt, slotEcon, plateauLo, pickBestRoi, pickMostIncome, pickMaxPayout, pickBalancedAt, pickPerCount,
  optSettings, setOpt, resetOpt, OPT_DEFAULTS } = E;

const OFF = { payMax: false, cushion: false };
// a thin edge on the 2-step preset: some accounts die inside a year
const setup = () => { setFirm(twoStep()); S.trades = edge(0.45, 1.6, 200); setPayModel(OFF); };

// ---------------------------------------------------------------------------
// the engine's payout and sizing model
// ---------------------------------------------------------------------------
test("model off is the pre-2.20 path exactly; the default model is off", () => {
  setup();
  assert.deepEqual(payModel(), OFF);
  const T = yearSteps();
  for (const seed of [3, 4, 5]) {
    assert.deepEqual(fundedSim(0.8, T, mulberry(seed)), fundedSim(0.8, T, mulberry(seed), undefined, OFF));
  }
});

test("max payout with a dollar cap: every withdrawal is the whole cap", () => {
  setFirm(futures({ payoutCapAmt: 1500 })); S.trades = edge(0.55, 1.5, 100);
  const cap = maxPayNeed();
  assert.equal(cap, 3, "$1,500 on $50k is 3% of the account");
  let n = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const ev = { pays: [], amts: [], death: -1 };
    fundedSim(0.8, yearSteps(), mulberry(seed), ev, { payMax: true, cushion: false });
    ev.amts.forEach((a) => { assert.ok(Math.abs(a - cap) < 1e-9, "a max payout took " + a + "%, not the cap"); n++; });
  }
  assert.ok(n > 30, "the fixture must pay: " + n);
});

test("max payout follows the firm's cadence; the habit never did", () => {
  setFirm(futures({ ddType: "static", payoutEvery: 20 })); S.trades = edge(0.6, 1.5, 100);
  const tpd = tpdOf();
  for (let seed = 1; seed <= 20; seed++) {
    const ev = { pays: [], amts: [], death: -1 };
    fundedSim(0.6, yearSteps(), mulberry(seed), ev, { payMax: true, cushion: false });
    assert.ok(ev.pays.length === 0 || ev.pays[0] >= 20 * tpd - 1, "first window opened early: step " + ev.pays[0]);
    for (let k = 1; k < ev.pays.length; k++) assert.ok(ev.pays[k] - ev.pays[k - 1] >= 20 * tpd - tpd, "payouts closer than 20 days");
  }
  const habit = { pays: [], amts: [], death: -1 };
  fundedSim(0.6, yearSteps(), mulberry(1), habit, OFF);
  assert.ok(habit.pays.length > 12, "the habit sweeps weekly whatever the firm says: " + habit.pays.length);
});

test("uncapped max payout takes everything above the cushion - more than the 5% habit chunk", () => {
  setFirm(futures({ ddType: "static" })); S.trades = edge(0.6, 2, 100);
  const ev = { pays: [], amts: [], death: -1 };
  fundedSim(1, yearSteps(), mulberry(7), ev, { payMax: true, cushion: false });
  assert.ok(Math.max(...ev.amts) > 5, "some sweep should exceed 5%: " + Math.max(...ev.amts));
});

test("cushion sizing draws one number per trade, so copy-trading stays exact", () => {
  setup();
  const T = yearSteps();
  setPayModel({ payMax: true, cushion: true });
  for (let seed = 1; seed <= 15; seed++) {
    const single = fundedSim(0.9, T, mulberry(seed));
    const p = portfolioSim([0.9, 0.9], T, seed, false, false, 0);
    assert.equal(p.profitPct, 2 * single.profit);
    assert.equal(p.aliveEnd, 2 * single.alive);
  }
  setPayModel(OFF);
});

test("cushion sizing trades smaller in a drawdown, so it outlives fixed % at the same start risk", () => {
  setup();
  const T = yearSteps();
  const f = fundedStats(1.2, 400, T).surv;
  setPayModel({ payMax: false, cushion: true });
  const c = fundedStats(1.2, 400, T).surv;
  setPayModel(OFF);
  assert.ok(c > f, "cushion " + c + " vs fixed " + f);
});

// ---------------------------------------------------------------------------
// several accounts
// ---------------------------------------------------------------------------
test("one account, no rebuy: the portfolio simulator IS the single-account engine", () => {
  setup();
  const T = yearSteps();
  for (const seed of [11, 22, 33, 44]) {
    const single = fundedSim(0.8, T, mulberry(seed));
    const port = portfolioSim([0.8], T, seed, false, false, 0);
    assert.equal(port.profitPct, single.profit, "same banked profit, seed " + seed);
    assert.equal(port.aliveEnd, single.alive);
    assert.equal(port.allDown, single.alive ? 0 : 1, "one account down = all down");
    assert.equal(port.bought, 1);
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

test("staggered purchases diversify copy-trading", () => {
  setup();
  const T = yearSteps(), stag = 20 * tpdOf();
  let same = 0, staggered = 0, bought = 0;
  for (let seed = 1; seed <= 60; seed++) {
    same += portfolioSim([0.9, 0.9, 0.9], T, seed, false, true, 50).allDown;
    const p = portfolioSim([0.9, 0.9, 0.9], T, seed, false, true, 50, stag);
    staggered += p.allDown; bought += p.bought;
  }
  assert.equal(bought, 180, "all three bought inside the year");
  assert.ok(staggered < same, "staggered all down " + staggered + " vs same-day " + same);
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

// ---------------------------------------------------------------------------
// the economics of a slot
// ---------------------------------------------------------------------------
test("slot economics: a survivor pays its one purchase back; deaths cost re-buys and time", () => {
  // never dies: one cycle a year, fees = one purchase
  const keep = slotEcon(20, 1, 1000, 1000, 2, 100);
  assert.deepEqual([keep.cycles, keep.rebuys, keep.fees, keep.pay, keep.roi], [1, 0, 2, 20, 10]);
  // always dies at mid-year, 100 trades to re-fund: cycle 600, 1000/600 cycles
  const die = slotEcon(6, 0, 500, 1000, 2, 100);
  assert.ok(Math.abs(die.cycles - 1000 / 600) < 1e-12);
  assert.ok(Math.abs(die.rebuys - 1000 / 600) < 1e-12);
  assert.ok(Math.abs(die.fees - 2 * (1 + 1000 / 600)) < 1e-12);
  assert.ok(Math.abs(die.roi - (6 * 1000 / 600) / (2 * (1 + 1000 / 600))) < 1e-12);
  // a dearer evaluation lowers the return, all else equal
  assert.ok(slotEcon(6, 0, 500, 1000, 4, 100).roi < die.roi);
});

test("robust floors, plateaus and the picks", () => {
  const mat = [[1, 5, 9], [2, 4, 8], [3, 6, 1], [4, 7, 2]];
  assert.deepEqual(floorAt(mat, 0.75), [2, 5, 2], "the value 3 of 4 records reach");
  assert.deepEqual(sharesAt(mat, 4), [0.25, 1, 0.5]);
  // the least size within 3% of the best; nothing positive = -1
  assert.equal(plateauLo([1, 9.8, 10, 4]), 1);
  assert.equal(plateauLo([-1, -2]), -1);
  assert.equal(pickBestRoi([2, 3.12, 3.2, 3.15]), 1);
  assert.equal(pickMostIncome([5, 9, 12, 11.8]), 2);
  assert.equal(pickMaxPayout([4, 10, 10.1, 10.1]), 1, "past the knee more size takes no more max payouts");
  // Balanced: largest clearing 85% measured AND in 90% of plausible edges
  const surv = [1, 0.98, 0.94, 0.9, 0.86, 0.6], shares = [1, 1, 0.95, 0.85, 0.6, 0];
  assert.equal(pickBalancedAt(surv, shares, 5, 0.85, 0.9), 2);
  assert.equal(pickBalancedAt(surv, shares, 5, 0.97, 0.9), 1);
});

test("several accounts: per count, the best ROI whose all-down risk stays under the bar", () => {
  const st = (n, base, roi, pAllDown) => ({ n, base, payYear: 0, feesYear: 0, fees95: 0, netYear: 0, roi, pAllDown, rebuys: 0 });
  // one account must size down to keep the all-down risk under 15%...
  const one = pickPerCount([st(1, 0.3, 4, 0.05), st(1, 0.5, 6, 0.12), st(1, 0.8, 9, 0.3)], 0.15);
  assert.equal(one.stat.base, 0.5); assert.ok(one.ok);
  // ...three that cover for each other can run the best-ROI size
  const three = pickPerCount([st(3, 0.3, 4, 0.01), st(3, 0.5, 6, 0.02), st(3, 0.8, 9, 0.1)], 0.15);
  assert.equal(three.stat.base, 0.8);
  // nothing meets the bar: the safest, flagged
  const none = pickPerCount([st(1, 0.5, 6, 0.4), st(1, 0.8, 9, 0.6)], 0.15);
  assert.equal(none.stat.base, 0.5); assert.equal(none.ok, false);
});

test("settings: defaults out of the box (max payout on), garbage clamped, the engine follows", () => {
  localStorage.removeItem("pel_opt");
  assert.deepEqual(optSettings(), OPT_DEFAULTS);
  assert.equal(OPT_DEFAULTS.payMax, true);
  localStorage.setItem("pel_opt", JSON.stringify({ survTarget: 7, conf: "x", maxAccounts: 99, copy: "yes", staggerDays: -4, payMax: 1 }));
  const o = optSettings();
  assert.equal(o.survTarget, 0.99);
  assert.equal(o.conf, OPT_DEFAULTS.conf);
  assert.equal(o.maxAccounts, 10);
  assert.equal(o.copy, OPT_DEFAULTS.copy);
  assert.equal(o.staggerDays, 0);
  assert.equal(o.payMax, OPT_DEFAULTS.payMax);
  setOpt({ payMax: false, cushion: true });
  assert.deepEqual(payModel(), { payMax: false, cushion: true }, "setOpt must reach the engine at once");
  resetOpt();
  assert.deepEqual(payModel(), { payMax: true, cushion: false });
  setPayModel(OFF);
  localStorage.removeItem("pel_opt");
});
