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
const { S, setFirm, fundedSim, fundedStats, portfolioSim, portfolioPrefix, mulberry, yearSteps, setPayModel, payModel, maxPayNeed, tpdOf,
  sharesAt, floorAt, slotEcon, plateauLo, pickMaxEv, SURV_PRESETS, pickMaxPayout, pickBalancedAt, pickPerCount,
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
test("account economics: per account over its life, no calendar year", () => {
  // 20% of account withdrawn over 400 trades, costing 2% and 100 trades to get funded
  const e = slotEcon(20, 400, 2, 100, 100);
  assert.equal(e.roi, 10, "$10 back per $1");
  assert.equal(e.net, 18);
  assert.equal(e.months, 5, "100 trades to fund + 400 funded, at 100 a month");
  assert.equal(e.liveMonths, 4);
  assert.ok(Math.abs(e.perMonth - 18 / 5) < 1e-12, "the slot's net spread over the whole cycle");
  // a dearer evaluation lowers the return, all else equal
  assert.ok(slotEcon(20, 400, 4, 100, 100).roi < e.roi);
});

test("moved to live: the account ends paid after N payouts or $X, in step with the sim", () => {
  setFirm(futures({ liveAfterPays: 3 })); S.trades = edge(0.6, 1.5, 100); setPayModel(OFF);
  let ended = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const ev = { pays: [], amts: [], death: -1 };
    const r = fundedSim(0.6, yearSteps() * 2, mulberry(seed), ev);
    if (r.live) { ended++; assert.equal(r.pays, 3); assert.equal(r.alive, 1); assert.equal(r.life, ev.pays[2] + 1, "ends on the third payout"); }
    else assert.ok(r.pays < 3, "an account that paid three times must have moved to live");
  }
  assert.ok(ended > 10, "the fixture should move accounts to live: " + ended);
  setFirm(futures({ liveAfterPaid: 6000 }));   // 12% of $50k
  for (let seed = 1; seed <= 20; seed++) {
    const r = fundedSim(0.6, yearSteps() * 2, mulberry(seed));
    if (r.live) assert.ok(r.profit >= 12 - 1e-9 && r.profit < 12 + 5 + 1e-9, "ends on the payout that crosses $6,000: " + r.profit);
  }
  // off: never
  setFirm(futures()); assert.equal(fundedSim(0.6, yearSteps() * 2, mulberry(1)).live, 0);
});

test("several counts from one run: the first N accounts ARE an N-account portfolio", () => {
  setup();
  const T = yearSteps(), stag = 10 * tpdOf();
  for (const ind of [false, true]) {
    for (let seed = 1; seed <= 8; seed++) {
      const pre = portfolioPrefix(0.9, [1, 2, 5], T, seed, ind, true, 50, stag);
      for (const p of pre) {
        const full = portfolioSim(new Array(p.n).fill(0.9), T, seed, ind, true, 50, stag);
        assert.ok(Math.abs(full.profitPct - p.profitPct) < 1e-9, (ind ? "independent" : "copy") + " n=" + p.n + " profit");
        assert.equal(full.rebuys, p.rebuys); assert.equal(full.bought, p.bought); assert.equal(full.allDown, p.allDown);
      }
    }
  }
  // copy-trade, same day: one account scaled
  const same = portfolioPrefix(0.9, [1, 50], T, 3, false, true, 50, 0);
  assert.ok(Math.abs(same[1].profitPct - 50 * same[0].profitPct) < 1e-9);
  assert.equal(same[1].allDown, same[0].allDown);
});

test("robust floors, plateaus and the picks", () => {
  const mat = [[1, 5, 9], [2, 4, 8], [3, 6, 1], [4, 7, 2]];
  assert.deepEqual(floorAt(mat, 0.75), [2, 5, 2], "the value 3 of 4 records reach");
  assert.deepEqual(sharesAt(mat, 4), [0.25, 1, 0.5]);
  // the least size within 3% of the best; nothing positive = -1
  assert.equal(plateauLo([1, 9.8, 10, 4]), 1);
  assert.equal(plateauLo([-1, -2]), -1);
  // Max EV: the least size within 3% of the most expected profit per account
  assert.equal(pickMaxEv([5, 9, 12, 11.8]), 2);
  assert.equal(pickMaxEv([5, 11.7, 12, 11.8]), 1);
  assert.equal(pickMaxEv([-3, -1]), -1, "nothing nets money after fees");
  // the standard survival levels, safest first
  assert.deepEqual(SURV_PRESETS, [0.99, 0.95, 0.9, 0.8]);
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
  assert.equal(OPT_DEFAULTS.survTarget, 0.9, "the default target is one of the presets");
  assert.equal(OPT_DEFAULTS.maxAccounts, 1, "one account until you say otherwise");
  localStorage.setItem("pel_opt", JSON.stringify({ survTarget: 7, conf: "x", maxAccounts: 99, copy: "yes", staggerDays: -4, payMax: 1 }));
  const o = optSettings();
  assert.equal(o.survTarget, 0.99);
  assert.equal(o.conf, OPT_DEFAULTS.conf);
  assert.equal(o.maxAccounts, 50, "up to 50 accounts");
  assert.equal(o.maxLifeMonths, 24);
  // 2.22.1: the account life is no longer a setting - an old saved value is ignored
  localStorage.setItem("pel_opt", JSON.stringify({ maxLifeMonths: 3 }));
  assert.equal(optSettings().maxLifeMonths, 24, "a saved 3-month life must not survive");
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

// ---------------------------------------------------------------------------
// 2.21.1: drawn evaluation attempts, block resampling
// ---------------------------------------------------------------------------
test("one purchase draws its attempts: the mean is the expected cost, the tail is not", () => {
  setFirm(futures({ fee: 100, resetFee: 0 }));
  const buy = E.evalBuyer(0.4, 10, 15, 12, false);
  const rnd = mulberry(7);
  const costs = [], steps = [];
  for (let i = 0; i < 4000; i++) { const p = buy(rnd); costs.push(p.cost); steps.push(p.steps); }
  const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
  const exp = E.costToFund(0.4, 12).cost;
  assert.ok(Math.abs(mean - exp) / exp < 0.05, "mean drawn cost " + mean + " vs expected " + exp);
  costs.sort((a, b) => a - b);
  assert.ok(costs[Math.floor(0.95 * costs.length)] >= 2 * exp, "a bad purchase takes several attempts: p95 " + costs[Math.floor(0.95 * costs.length)]);
  assert.ok(Math.min(...steps) === 15 * tpdOf(), "a first-time pass waits the median pass time");
  // costToFund is costOfAttempts at the expected attempts, unchanged
  assert.equal(E.costToFund(0.4, 12).cost, E.costOfAttempts(1 / 0.4, 12).cost);
});

test("drawn purchases leave the trades alone and fill the fee tail", () => {
  setup();
  const T = yearSteps();
  const buy = E.evalBuyer(0.4, 10, 15, 12, false);
  let tailFixed = [], tailDrawn = [];
  for (let seed = 1; seed <= 60; seed++) {
    // the same AVERAGE wait as the drawn purchases: (1/0.4 - 1) x 10 + 15 = 30 days
    const fixed = portfolioPrefix(1.0, [1], T, seed, false, true, 30 * tpdOf(), 0)[0];
    const drawn = portfolioPrefix(1.0, [1], T, seed, false, true, 50, 0, buy)[0];
    tailFixed.push((fixed.bought + fixed.rebuys) * E.costToFund(0.4, 12).cost);
    tailDrawn.push(drawn.fees);
    assert.ok(drawn.fees > 0, "every account bought is paid for");
  }
  // the first account runs on the identical stream either way: same first-life outcome
  const a = portfolioPrefix(0.5, [1], T, 3, false, false, 50, 0)[0], b = portfolioPrefix(0.5, [1], T, 3, false, false, 50, 0, buy)[0];
  assert.equal(a.profitPct, b.profitPct, "without replacement the purchase draw cannot touch the trades");
  tailFixed.sort((x, y) => x - y); tailDrawn.sort((x, y) => x - y);
  assert.ok(tailDrawn[57] > tailFixed[57], "the bad-run budget is higher once failures are drawn: " + tailDrawn[57] + " vs " + tailFixed[57]);
});

test("plausible records keep streaks: block resampling", () => {
  const rs = Array.from({ length: 1000 }, (_, i) => (Math.floor(i / 50) % 2 ? 1.5 : -1));   // long runs
  const out = E.blockResample(rs, 42);
  assert.equal(out.length, rs.length);
  assert.ok(out.every((v) => v === 1.5 || v === -1));
  let same = 0, sameIid = 0;
  const iid = E.resampleRecord(rs, 42);
  for (let i = 1; i < out.length; i++) { if (out[i] === out[i - 1]) same++; if (iid[i] === iid[i - 1]) sameIid++; }
  assert.ok(same > 0.85 * 999, "blocks keep neighbours together: " + same);
  assert.ok(sameIid < 0.6 * 999, "an iid resample breaks them: " + sameIid);
});
