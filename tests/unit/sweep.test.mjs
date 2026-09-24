// The target sweep: "I take 1.5R every time and keep watching it run to 4R -
// what should the target be?"
//
// Under a mechanical stop at 1R, a target of T pays +T when the move reached T
// before coming back to the stop, and -1R when it did not. That is one number
// per trade (runR) and makes the answer arithmetic rather than a simulation.
//
// The two properties that matter most are both about REFUSING to invent:
//   - a winner with no logged run counts as reaching EXACTLY its own target and
//     never a hair more, so an unlogged run can never become a bigger one;
//   - a loser needs nothing logged at all, because losing under a target of P
//     already proves the run fell short of P.
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, trade } from "./env.mjs";
import { buildOnce } from "./build.mjs";

installDom();
const E = await import(await buildOnce("sweep"));
const { targetSweep } = E;

// a trade on a mechanical 1R stop / 1.5R target, long from 100
const W = (run) => trade({ entry: 100, stop: 99, target: 101.5, exit: 101.5, R: 1.5, Rmanual: true, riskAmt: 100, pnl: 150, runR: run == null ? null : run });
const L = () => trade({ entry: 100, stop: 99, target: 101.5, exit: 99, R: -1, Rmanual: true, riskAmt: 100, pnl: -100, runR: null });
const at = (pts, t) => pts.find((p) => Math.abs(p.t - t) < 1e-6);

test("an R-FIRST journal with no prices anywhere still sweeps", () => {
  // THE BUG THIS REPLACES, and it is one this codebase had already learned once.
  // plannedRR() read entry/stop/target only, so a journal kept in Risk $ and R -
  // which never has to name a price, and which is the whole point of an R-first
  // record - produced a planned target of null on every single trade. The panel
  // reported "nothing to sweep" on a record of 30+ trades and pointed the user at
  // the one thing they had deliberately chosen not to log. excursions() fixed
  // exactly this for MFE/MAE; plannedRR had not.
  const noPrices = (over) => trade({
    entry: null, stop: null, target: null, exit: null,
    riskAmt: 100, pnl: 150, R: 1.5, Rmanual: true, rrR: 1.5, ...over,
  });
  const W = (run) => noPrices({ runR: run });
  const L = () => noPrices({ pnl: -100, R: -1, runR: null });
  const { pts, floor } = targetSweep([...Array(8)].map(() => W(4)).concat([...Array(8)].map(L)));
  assert.equal(floor, 1.5, "the typed R:R is the target, no prices required");
  assert.ok(pts.length > 0, "a price-free record must produce a curve");
  assert.equal(at(pts, 3).wins, 8, "the eight that ran to 4R count as hits at 3R");
  assert.equal(at(pts, 3).n, 16);
});

test("a typed R:R beats the prices when a trade carries both", () => {
  // A number someone entered is a statement; a derived one is not. If this ever
  // flips, editing the typed box would silently do nothing on any trade that also
  // has prices on it.
  const both = trade({
    entry: 100, stop: 99, target: 103,   // prices say 3.0R
    exit: 101.5, R: 1.5, Rmanual: true, riskAmt: 100, pnl: 150,
    rrR: 1.5,                            // the trader says 1.5R
  });
  const l = trade({ entry: 100, stop: 99, target: 103, exit: 99, R: -1, Rmanual: true, riskAmt: 100, pnl: -100, rrR: 1.5 });
  const { floor } = targetSweep([...Array(6)].map(() => both).concat([...Array(6)].map(() => l)));
  assert.equal(floor, 1.5, "the typed 1.5R wins over the 3.0R the prices imply");
});

test("a winner counts for what it PAID, never for what it was aiming at", () => {
  // Caught from the running app. The user backfilled a planned R:R of 4 on a
  // record that exits at 1.5R - the MFE in the target box, an easy mix-up - and
  // the sweep credited every winner with having reached 4R, then reported 45% of
  // trades hitting a 4R target and +1.25R a trade. All of it invented, from one
  // wrong field. The realised R is a measurement; the plan is an intention, and
  // an intention is not evidence that price ever got there.
  const W = () => trade({ entry: null, stop: null, target: null, exit: null,
    riskAmt: 100, pnl: 150, R: 1.5, Rmanual: true, rrR: 4, runR: null });
  const L = () => trade({ entry: null, stop: null, target: null, exit: null,
    riskAmt: 100, pnl: -100, R: -1, Rmanual: true, rrR: 4, runR: null });
  const r = targetSweep([...Array(9)].map(W).concat([...Array(11)].map(L)));
  assert.equal(r.short, 9, "all nine winners paid less than the 4R they claim");
  const at4 = r.pts.find((p) => Math.abs(p.t - 4) < 1e-6);
  assert.equal(at4.wins, 0, "not one of them reached 4R, so none may count as a hit there");
  assert.ok(at4.exp < 0, "and the expectancy at 4R must be negative, not +1.25R");
});

test("a logged run still lifts a winner above what it paid", () => {
  // The correction must not throw away the real observation: a 1.5R exit that
  // went on to 4.2R before the stop was ever threatened did reach 4.2R.
  const W = (run) => trade({ entry: null, stop: null, target: null, exit: null,
    riskAmt: 100, pnl: 150, R: 1.5, Rmanual: true, rrR: 1.5, runR: run });
  const L = () => trade({ entry: null, stop: null, target: null, exit: null,
    riskAmt: 100, pnl: -100, R: -1, Rmanual: true, rrR: 1.5, runR: null });
  const r = targetSweep([...Array(8)].map(() => W(4.2)).concat([...Array(8)].map(L)));
  const at4 = r.pts.find((p) => Math.abs(p.t - 4) < 1e-6);
  assert.equal(at4.wins, 8, "the logged run is the evidence, and it says 4.2R");
  assert.equal(r.short, 0, "exiting at the target is not a short exit");
});

test("a mixed book sweeps from the LOWEST target, not the highest", () => {
  // Reported from the running app: "my standard run is 1.5 so why isnt it
  // showing from that to the higher rr?" The floor was max(planned), so a single
  // 4R trade in the book hid every row between 1.5R and 4R - exactly the range
  // the panel exists to search.
  const mk = (p, won, run) => trade({
    entry: null, stop: null, target: null, exit: null, riskAmt: 100,
    pnl: won ? p * 100 : -100, R: won ? p : -1, Rmanual: true, rrR: p,
    runR: won ? run : null,
  });
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(mk(1.5, i % 2 === 0, 5));   // the habit
  for (let i = 0; i < 4; i++) rows.push(mk(4, i % 2 === 0, 6));      // a few bigger
  const r = targetSweep(rows);
  assert.equal(r.floor, 1.5, "the floor is the lowest target traded, got " + r.floor);
  assert.ok(at(r.pts, 1.5), "1.5R must be on the table");
  assert.ok(at(r.pts, 2.5), "and so must everything between it and 4R");
  assert.ok(r.mixed, "a book with two targets must declare that its population moves");
});

test("a trade aiming higher stays OUT of the columns below its own target", () => {
  // The reason max looked right. A loser planned at 4R proves the run fell short
  // of 4R and says nothing about 2R, so counting it as a loss at 2R would invent
  // a verdict. It joins the column only once the target reaches its own.
  const mk = (p, won) => trade({
    entry: null, stop: null, target: null, exit: null, riskAmt: 100,
    pnl: won ? p * 100 : -100, R: won ? p : -1, Rmanual: true, rrR: p, runR: null,
  });
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(mk(1.5, i < 3));   // 3 win, 3 lose
  for (let i = 0; i < 4; i++) rows.push(mk(4, false));     // 4 losers aiming at 4R
  const r = targetSweep(rows);
  assert.equal(at(r.pts, 1.5).n, 6, "only the six 1.5R trades may speak about 1.5R");
  assert.equal(at(r.pts, 4).n, 10, "at 4R the whole book is in scope");
  assert.equal(at(r.pts, 1.5).wins, 3);
  assert.equal(at(r.pts, 4).wins, 0, "nothing reached 4R");
});

test("the sweep starts at the target you were actually trading, never below it", () => {
  // Below your own target the record cannot answer: a trade that ran to 1.2R and
  // reversed is written down only as a loss, so nothing says whether a 1.0R
  // target would have caught it. Refusing that half is the whole floor.
  const { pts, floor } = targetSweep([...Array(10)].map(() => W(4)).concat([...Array(10)].map(L)));
  assert.equal(floor, 1.5);
  assert.ok(pts.length > 0);
  assert.ok(pts[0].t >= 1.5 - 1e-9, "first candidate is the current target, got " + pts[0].t);
  assert.equal(at(pts, 1.25), undefined, "nothing below the floor may appear");
});

test("a loser needs nothing logged - losing already proves the run fell short", () => {
  const { pts } = targetSweep([...Array(6)].map(() => W(5)).concat([...Array(14)].map(L)));
  const p = at(pts, 3);
  assert.equal(p.n, 20, "every resolved trade with a target is in the denominator");
  assert.equal(p.wins, 6, "only the six that ran to 5R count as hits at 3R");
  // hand-computed: (6 * 3 - 14 * 1) / 20
  assert.ok(Math.abs(p.exp - (6 * 3 - 14) / 20) < 1e-9, "expectancy is (wins*T - losses) / n, got " + p.exp);
});

test("a winner with NO logged run counts as reaching its target and not a hair more", () => {
  // THE ANTI-FABRICATION PROPERTY. An unlogged run is not a bigger run. If this
  // ever loosens, the sweep starts crediting trades with distance nobody
  // measured, and it would do it in the direction of a bigger target.
  const { pts } = targetSweep([...Array(10)].map(() => W(null)).concat([...Array(10)].map(L)));
  assert.equal(at(pts, 1.5).wins, 10, "they did reach 1.5R - that is what winning meant");
  assert.equal(at(pts, 1.75).wins, 0, "and nothing proves they went one tick further");
  assert.equal(at(pts, 4).wins, 0);
});

test("with no runs logged at all the curve peaks at the target already in use", () => {
  // This is the degenerate case SWEEP_MIN_RUNS exists to refuse, and it is worth
  // pinning because of HOW it fails: not with a wide answer but with a confident
  // one that always agrees with whatever the trader is already doing.
  const { pts, nRun } = targetSweep([...Array(12)].map(() => W(null)).concat([...Array(8)].map(L)));
  assert.equal(nRun, 0, "nothing was logged");
  let best = pts[0];
  pts.forEach((p) => { if (p.exp > best.exp) best = p; });
  assert.equal(best.t, 1.5, "the peak is the status quo, which is why the panel refuses to draw this");
});

test("a run shorter than the target cannot pull a winner below its own target", () => {
  // A mis-typed 0.8 on a trade that demonstrably reached 1.5R is a data error,
  // not evidence. It must not be able to delete a hit that winning already proved.
  const { pts } = targetSweep([...Array(10)].map(() => W(0.8)).concat([...Array(10)].map(L)));
  assert.equal(at(pts, 1.5).wins, 10, "it won, so it reached 1.5R whatever the run field says");
});

test("hits fall monotonically as the target rises", () => {
  const runs = [1.6, 1.8, 2.2, 2.4, 3.1, 3.3, 4.0, 4.8, 5.2, 6.9];
  const { pts } = targetSweep(runs.map(W).concat([...Array(12)].map(L)));
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i].wins <= pts[i - 1].wins,
      "a higher target cannot be hit more often: " + pts[i - 1].t + "R->" + pts[i - 1].wins + " then " + pts[i].t + "R->" + pts[i].wins);
    assert.ok(pts[i].wr <= pts[i - 1].wr + 1e-12);
  }
});

test("a fat right tail moves the peak up, a thin one leaves it alone", () => {
  // The panel has to be able to say BOTH things, or it is not measuring anything.
  const losers = [...Array(22)].map(L);
  const peakOf = (runs) => {
    const { pts } = targetSweep(runs.map(W).concat(losers));
    let best = pts[0];
    pts.forEach((p) => { if (p.exp > best.exp) best = p; });
    return best.t;
  };
  // everything just tags the target and reverses
  const thin = peakOf([...Array(18)].map(() => 1.6));
  // the same winners, but they keep going
  const fat = peakOf([...Array(18)].map((_, i) => 3.5 + (i % 5) * 0.5));
  assert.equal(thin, 1.5, "nothing ran, so nothing justifies a bigger target");
  assert.ok(fat > thin, "runs that keep going must move the peak up, got " + fat + " vs " + thin);
});

test("a trade with no planned target is not in the population at all", () => {
  // "It lost" is only a statement about a target when there WAS one. A
  // discretionary exit says nothing about whether 3R was reachable.
  const noTarget = trade({ entry: 100, stop: 99, target: null, exit: 99, R: -1, Rmanual: true, riskAmt: 100, pnl: -100 });
  const { pts } = targetSweep([...Array(10)].map(() => W(4)).concat([...Array(5)].map(L)).concat([noTarget, noTarget]));
  assert.equal(at(pts, 3).n, 15, "the two targetless rows are excluded, not counted as losses");
});

test("a 0R scratch belongs to neither arm", () => {
  // Trap #16's rule applied here: it did not reach the target and it did not pay
  // the stop, so it is evidence about neither.
  const scratch = trade({ entry: 100, stop: 99, target: 101.5, exit: 100, R: 0, Rmanual: true, riskAmt: 100, pnl: 0 });
  const { pts } = targetSweep([...Array(8)].map(() => W(4)).concat([...Array(8)].map(L)).concat([scratch, scratch, scratch]));
  assert.equal(at(pts, 3).n, 16, "the three scratches are out of the denominator");
});

test("an empty or targetless record returns no curve rather than a flat one", () => {
  assert.deepEqual(targetSweep([]).pts, []);
  const noTarget = trade({ entry: 100, stop: 99, target: null, exit: 99, R: -1, Rmanual: true, riskAmt: 100, pnl: -100 });
  assert.deepEqual(targetSweep([noTarget, noTarget]).pts, []);
});

test("nRun counts only winners whose run was actually logged", () => {
  const r = targetSweep([W(4), W(4), W(null), L(), L()]);
  assert.equal(r.nWon, 3, "three winners");
  assert.equal(r.nRun, 2, "two of them carry a measured run");
});
