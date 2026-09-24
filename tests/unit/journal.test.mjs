// Journal statistics. This is the layer that carried the worst bugs of the
// 2.4.x audits - a scratch counted as a loss, fabricated R values feeding Kelly,
// a quality label that rewarded journal length - and it had no unit coverage at
// all. Each test below is one of those, pinned.
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, trade } from "./env.mjs";
import { buildOnce } from "./build.mjs";

installDom();
const J = await import(await buildOnce("journal"));

// R comes from riskAmt/pnl, so these have a real risk basis
const win = (r) => trade({ riskAmt: 100, pnl: 100 * r });
const scratch = () => trade({ riskAmt: 100, pnl: 0 });
const pnlOnly = (d) => trade({ riskAmt: null, pnl: d });   // broker-CSV shape: no basis

test("a 0R scratch is neither a win nor a loss", () => {
  const st = J.stats([win(1), win(1), win(-1), scratch()]);
  assert.equal(st.n, 4, "it still counts as a resolved trade");
  assert.equal(st.wins, 2);
  assert.equal(st.losses, 1);
  assert.equal(st.scr, 1);
  assert.ok(Math.abs(st.wr - 2 / 3) < 1e-12, "win rate is over DECIDED trades, got " + st.wr);
  assert.ok(Math.abs(st.exp - 0.25) < 1e-12, "expectancy still averages over all four");
});

test("the scratch does not narrow the win-rate confidence interval", () => {
  const base = J.statsDeep([win(1), win(1), win(-1), win(-1)]);
  const withScr = J.statsDeep([win(1), win(1), win(-1), win(-1), scratch(), scratch()]);
  assert.ok(Math.abs(base.wrLo - withScr.wrLo) < 1e-12, "a scratch says nothing about the win:loss coin");
  assert.ok(Math.abs(base.wrHi - withScr.wrHi) < 1e-12);
});

test("Kelly uses the decided win rate - the exact three-outcome optimum", () => {
  // 2W at +1R, 2L at -1R, plus scratches: b=1, wr=0.5 -> f* = 0
  const d = J.statsDeep([win(1), win(1), win(-1), win(-1), scratch(), scratch()]);
  assert.ok(Math.abs(d.kelly) < 1e-12, "scratches must not drag f* negative, got " + d.kelly);
});

test("fabricated +/-1R from P&L-only trades never reaches the R statistics", () => {
  // a $500 win and a $20 loss both become +/-1R without a stop - poison for R stats
  const real = [win(2), win(-1)];
  const withNoise = [...real, pnlOnly(500), pnlOnly(-20)];
  const a = J.stats(real), b = J.stats(withNoise);
  assert.equal(b.n, 4, "all four are resolved trades");
  assert.equal(b.rn, 2, "only two carry a risk basis");
  assert.ok(Math.abs(a.exp - b.exp) < 1e-12, "expectancy must not move");
  assert.ok(Math.abs(a.avgWin - b.avgWin) < 1e-12, "avg win must not move");
  assert.ok(Math.abs(a.sumR - b.sumR) < 1e-12, "Total R must not move");
  // but the dollars and the win/loss counts DO include them - a $ win is a win
  assert.equal(b.wins, 2);
  assert.equal(b.losses, 2);
  assert.equal(b.sum$, 200 - 100 + 500 - 20);
  const d = J.statsDeep(withNoise);
  assert.equal(d.n, 2, "the R path runs over risk-based trades only");
});

test("SQN is graded on Tharp's 100-trade ladder, not on how long the journal is", () => {
  const many = Array.from({ length: 400 }, (_, i) => win(i % 2 ? 1.2 : -1));
  const d = J.statsDeep(many);
  assert.ok(d.sqn > d.sqn100, "the raw t-stat keeps growing with n");
  const expected = (Math.sqrt(100) * d.exp) / d.sd;
  assert.ok(Math.abs(d.sqn100 - expected) < 1e-9, "the graded figure caps sqrt(n) at 100");
});

test("max drawdown and streaks read the journal in true entry order", () => {
  // same minute, logged in the order given - a stable sort must not reverse them
  const t = (min, r, seq) => trade({ dateTime: "2026-07-20T09:3" + min, riskAmt: 100, pnl: 100 * r, createdAt: seq });
  const d = J.statsDeep([t(0, 1, 1), t(0, -1, 2), t(0, -1, 3), t(1, 1, 4)]);
  assert.equal(d.maxL, 2, "two losses in a row");
  assert.ok(Math.abs(d.mdd - 2) < 1e-9, "peak +1 then -2 = 2R drawdown, got " + d.mdd);
});

test("tail ratio and avg win/loss ignore the scratch", () => {
  const st = J.stats([win(3), win(-1), scratch()]);
  assert.ok(Math.abs(st.avgWin - 3) < 1e-12);
  assert.ok(Math.abs(st.avgLoss - 1) < 1e-12, "the scratch must not dilute avg loss");
  assert.ok(Math.abs(st.pf - 3) < 1e-12);
});

test("an all-scratch record has no win rate rather than a zero one", () => {
  const st = J.stats([scratch(), scratch()]);
  assert.equal(st.wins, 0);
  assert.equal(st.losses, 0);
  assert.equal(st.wr, 0, "no decided trades - reported as 0, never as a division by zero");
  assert.ok(isFinite(st.exp) && st.exp === 0);
});

test("open trades are not 0R scratches", () => {
  const open = trade({ pnl: null, exit: null, riskAmt: 100 });
  const st = J.stats([win(1), open]);
  assert.equal(st.n, 1, "an unresolved trade is excluded entirely");
  assert.ok(Math.abs(st.exp - 1) < 1e-12, "it must not dilute expectancy toward zero");
});

test("fmtDur carries the hour instead of printing 60 minutes", () => {
  assert.equal(J.fmtDur(45), "45m");
  assert.equal(J.fmtDur(119.6), "2h", "was '1h 60m'");
  assert.equal(J.fmtDur(60), "1h");
  assert.equal(J.fmtDur(90), "1h 30m");
  assert.equal(J.fmtDur(1439.7), "1.0d", "was '23h 60m'");
});

test("MFE/MAE excursions carry the right sign on both directions", () => {
  const long = J.excursions(trade({ entry: 100, stop: 99, mfe: 102, mae: 99.5 }));
  assert.ok(Math.abs(long.mfeR - 2) < 1e-9, "got " + long.mfeR);
  assert.ok(Math.abs(long.maeR - 0.5) < 1e-9, "heat is reported positive, got " + long.maeR);
  const short = J.excursions(trade({ direction: "short", entry: 100, stop: 105, mfe: 94, mae: 104 }));
  assert.ok(Math.abs(short.mfeR - 1.2) < 1e-9, "got " + short.mfeR);
  assert.ok(Math.abs(short.maeR - 0.8) < 1e-9, "got " + short.maeR);
  assert.deepEqual(J.excursions(trade({ entry: null, stop: null })), { mfeR: null, maeR: null });
});

test("excursions can be logged in R with no price anywhere on the trade", () => {
  // the R-first journal: an R override, no entry, no stop, no prices at all.
  // Before this path existed, Exit management was unreachable for these traders.
  const rOnly = J.excursions(trade({ entry: null, stop: null, R: 1.5, Rmanual: true, mfeR: 2.4, maeR: 0.6 }));
  assert.ok(Math.abs(rOnly.mfeR - 2.4) < 1e-9, "got " + rOnly.mfeR);
  assert.ok(Math.abs(rOnly.maeR - 0.6) < 1e-9, "got " + rOnly.maeR);
  // heat is a magnitude: someone writing "0.6R against me" as -0.6 means the same
  assert.ok(Math.abs(J.excursions(trade({ maeR: -0.6 })).maeR - 0.6) < 1e-9, "MAE is read as a magnitude");
  // a typed R value is a statement, so it wins over the price derivation
  const both = J.excursions(trade({ entry: 100, stop: 99, mfe: 102, mae: 99.5, mfeR: 3.1 }));
  assert.ok(Math.abs(both.mfeR - 3.1) < 1e-9, "typed R wins for MFE, got " + both.mfeR);
  assert.ok(Math.abs(both.maeR - 0.5) < 1e-9, "the unset half still comes from prices, got " + both.maeR);
  // and nothing is invented when neither unit was logged
  assert.deepEqual(J.excursions(trade({ entry: null, stop: null, mfeR: null, maeR: null })), { mfeR: null, maeR: null });
});

test("excursions logged in money divide by what 1R is worth on the trade", () => {
  // $200 risk, so a $480 best point is +2.4R and $120 of heat is 0.6R
  const d = J.excursions(trade({ entry: null, stop: null, riskAmt: 200, mfeD: 480, maeD: 120 }));
  assert.ok(Math.abs(d.mfeR - 2.4) < 1e-9, "got " + d.mfeR);
  assert.ok(Math.abs(d.maeR - 0.6) < 1e-9, "got " + d.maeR);
  // heat typed as a negative dollar loss means the same thing
  assert.ok(Math.abs(J.excursions(trade({ riskAmt: 200, maeD: -120 })).maeR - 0.6) < 1e-9);
  // without a risk basis money cannot become R, and nothing is guessed
  assert.deepEqual(J.excursions(trade({ entry: null, stop: null, riskAmt: null, mfeD: 480, maeD: 120 })), { mfeR: null, maeR: null });
  // a zero or negative risk is not a divisor
  assert.deepEqual(J.excursions(trade({ entry: null, stop: null, riskAmt: 0, mfeD: 480 })), { mfeR: null, maeR: null });
  // precedence: a typed R outranks money, which outranks prices
  const all = J.excursions(trade({ entry: 100, stop: 99, mfe: 102, riskAmt: 200, mfeD: 480, mfeR: 3.1 }));
  assert.ok(Math.abs(all.mfeR - 3.1) < 1e-9, "R wins over money and prices, got " + all.mfeR);
  const dOverPrice = J.excursions(trade({ entry: 100, stop: 99, mfe: 102, riskAmt: 200, mfeD: 480 }));
  assert.ok(Math.abs(dOverPrice.mfeR - 2.4) < 1e-9, "money wins over prices, got " + dOverPrice.mfeR);
});

test("tradeR honours a manual override and re-derives an automatic one", () => {
  assert.equal(J.tradeR(trade({ R: 3, Rmanual: true, riskAmt: 100, pnl: 100 })), 3);
  assert.equal(J.tradeR(trade({ R: 3, Rmanual: false, riskAmt: 100, pnl: 100 })), 1, "auto trades self-heal from the fields");
});

// ---------------------------------------------------------------------------
// The dollar layer. R is the unit of record; dollars are derived, opt-in, and
// strictly one-way. Before this existed, stats() summed t.pnl alone, so a
// journal kept in R read a Balance built from whichever trades happened to
// carry a P&L - 14 of 72 in the case that prompted it, understating by ~60%.
// ---------------------------------------------------------------------------

// an R-only trade: a manual R, no P&L, no risk $ - nothing to price it with
const rOnly = (r, acct = "Main") => trade({ account: acct, R: r, Rmanual: true, riskAmt: null, pnl: null, fees: null });
function withBasis(basis, fn) {
  const prev = J.JMETA.rBasis, prevBal = J.JMETA.balances;
  J.JMETA.rBasis = basis;
  try { return fn(); } finally { J.JMETA.rBasis = prev; J.JMETA.balances = prevBal; }
}

test("trade$ prefers a logged P&L, then the trade's own risk, then the account R value", () => {
  withBasis({ Main: { mode: "fixed", v: 50 } }, () => {
    // logged P&L wins even when it disagrees with R x risk - it is the measurement
    assert.equal(J.trade$(trade({ R: 2, Rmanual: true, riskAmt: 100, pnl: 173 })), 173);
    // the trade's OWN risk outranks the account default: it is what was really risked
    assert.equal(J.trade$(trade({ R: 2, Rmanual: true, riskAmt: 100, pnl: null, fees: null })), 200);
    // and only then the account value
    assert.equal(J.trade$(rOnly(2)), 100);
    // fees come out of a DERIVED figure; a logged P&L is already net (autoPnl)
    assert.equal(J.trade$(trade({ R: 2, Rmanual: true, riskAmt: null, pnl: null, fees: 4 })), 96);
    // resolved by an exit price alone: no P&L, and no stop to measure R against.
    // tradeR would hand back 0 here, so pricing it would invent a $0 scratch.
    const exitOnly = trade({ entry: null, stop: null, exit: 4210, riskAmt: null, pnl: null, R: null, Rmanual: false });
    assert.equal(J.hasRBasis(exitOnly), false);
    assert.equal(J.trade$(exitOnly), null, "an R value may only price a trade whose R is a measurement");
  });
  // with no basis anywhere the answer is "unknown", never zero
  assert.equal(J.trade$(rOnly(2)), null);
});

test("stats() prices R-only trades once the account has an R value, and says how many", () => {
  const list = [rOnly(1), rOnly(-1), rOnly(2), trade({ riskAmt: 100, pnl: 100 })];
  const before = J.stats(list);
  assert.equal(before.sum$, 100, "only the one logged P&L is money");
  assert.equal(before.d$n, 1, "three trades cannot be priced at all");
  assert.equal(before.n - before.d$n, 3);
  withBasis({ Main: { mode: "fixed", v: 50 } }, () => {
    const after = J.stats(list);
    assert.equal(after.sum$, 50 - 50 + 100 + 100, "2R at $50 plus the logged $100");
    assert.equal(after.d$n, 4, "every trade is priced now");
    assert.equal(after.d$logged, 1, "but only one of them from a logged P&L");
    assert.ok(Math.abs(after.sumR - before.sumR) < 1e-12, "the R layer must not move by a digit");
    assert.ok(Math.abs(after.exp - before.exp) < 1e-12, "nor expectancy");
  });
});

test("the R value buys dollars, never a risk basis - the one-way contract", () => {
  // A P&L-only row (every broker CSV) has no measurable R. An account R value
  // must not change that: if it ever did, computeRraw's sign guess would come
  // back as a whole fabricated risk unit and poison Kelly, SQN and the odds MC.
  const csvRow = pnlOnly(500);
  withBasis({ Main: { mode: "fixed", v: 50 } }, () => {
    assert.equal(J.hasRBasis(csvRow), false, "still no risk basis");
    assert.equal(J.resolvedRs([csvRow]).length, 0, "still out of the R statistics");
    const st = J.stats([win(2), csvRow]);
    assert.equal(st.rn, 1, "only the real trade carries an R");
    assert.equal(st.sum$, 200 + 500, "its dollars are its own logged P&L, not R x the account value");
  });
});

test("a 'percent of start' R value needs a starting balance, and resolves to null without one", () => {
  const t = rOnly(2);
  withBasis({ Main: { mode: "pct", v: 5 } }, () => {
    J.JMETA.balances = {};
    assert.equal(J.trade$(t), null, "5% of an unknown balance is unknown, not zero");
    J.JMETA.balances = { Main: 1000 };
    assert.equal(J.trade$(t), 100, "5% of $1,000 = $50 per R, so 2R = $100");
  });
});

test("a zero or negative R value is refused rather than pricing everything at nothing", () => {
  for (const bad of [0, -50, NaN]) {
    withBasis({ Main: { mode: "fixed", v: bad } }, () => {
      assert.equal(J.trade$(rOnly(2)), null, "R value " + bad + " must not price a trade");
    });
  }
});

// ---------------------------------------------------------------------------
// The two populations, and what happens when a number is built from both
// ---------------------------------------------------------------------------

test("Kelly divides the R-basis win rate into the R-basis payoff, not one of each", () => {
  // Three priced wins at +2R, two priced losses at -1R, and four broker-CSV rows
  // that are resolved but carry no risk basis. The two populations then genuinely
  // disagree: 7 of 9 decided trades won, but only 3 of 5 MEASURABLE ones did.
  const list = [win(2), win(2), win(2), win(-1), win(-1), pnlOnly(500), pnlOnly(500), pnlOnly(500), pnlOnly(500)];
  const st = J.stats(list);
  assert.equal(st.wins, 7, "the sign of a P&L-only row is real data - it counts as a win");
  assert.equal(st.losses, 2);
  assert.equal(st.rwins, 3, "...but its MAGNITUDE is not, so it is outside the R-basis counts");
  assert.equal(st.rlosses, 2);
  assert.ok(Math.abs(st.wr - 7 / 9) < 1e-9, "wr stays over every decided trade");
  assert.ok(Math.abs(st.wrR - 0.6) < 1e-9, "wrR is the same rate over the measurable ones");

  // b = avgWin / avgLoss = 2 / 1, both measured on the R-basis population.
  // Pairing it with wr gives 0.778 - 0.222/2 = 0.667; with wrR, 0.6 - 0.4/2 = 0.4.
  // The first is an f* for a trader who does not exist.
  const dq = J.statsDeep(list);
  assert.ok(Math.abs(dq.kelly - 0.4) < 1e-9,
    "Kelly must use the R-basis rate, got " + dq.kelly + " (0.667 means it is mixing populations again)");
});

test("on a fully priced record the two populations coincide exactly", () => {
  // ...which is why the bug above survived: every test fixture and most real
  // journals price every trade, and then wr === wrR by construction.
  const list = [win(2), win(2), win(-1), scratch(), win(1.5)];
  const st = J.stats(list);
  assert.equal(st.wins, st.rwins);
  assert.equal(st.losses, st.rlosses);
  assert.ok(Math.abs(st.wr - st.wrR) < 1e-12);
});
