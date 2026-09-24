// The Timing tab: the axes, the coverage accounting, and the two bars a bucket
// has to clear before the app will call it real.
//
// THE TIMEZONE IS LOAD-BEARING AND IS SET BEFORE ANY IMPORT. dowOf's whole
// reason to exist is a UTC-vs-local parsing split that is INVISIBLE at UTC and
// east of it, so a suite running at UTC would pass against the bug it was
// written to catch. New York is fixed at UTC-4/-5 year round, and the first
// assertion below proves the setting actually took - if Node ignored it, that
// test fails loudly rather than every other test passing vacuously.
process.env.TZ = "America/New_York";

import test from "node:test";
import assert from "node:assert/strict";
import { installDom, trade } from "./env.mjs";
import { buildOnce } from "./build.mjs";

installDom();
const E = await import(await buildOnce("timing"));
const {
  dowOf, hourOf, hourLabel, durBucket, dayOrdinals, postLossGaps,
  timeBuckets, separability, dayCountRows, CUT_MIN_N,
} = E;

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hourKey = (t) => { const h = hourOf(t); return h == null ? null : { k: hourLabel(h), ord: h }; };
const dowKey = (t) => { const d = dowOf(t); return d == null ? null : { k: DOW[d], ord: (d + 6) % 7 }; };

// ---------------------------------------------------------------------------
// The weekday bug
// ---------------------------------------------------------------------------

test("the test process really is west of UTC, or nothing below proves anything", () => {
  // 2026-08-02 is a Sunday. Parsed bare it is UTC midnight, which west of UTC is
  // still SATURDAY EVENING locally. If these two agree, TZ did not take and the
  // weekday assertions underneath would be vacuous.
  assert.equal(new Date("2026-08-02").getDay(), 6, "bare date must parse as UTC midnight -> Saturday here");
  assert.equal(new Date("2026-08-02T09:30").getDay(), 0, "a dated-and-timed string must parse as local -> Sunday");
});

test("a date-only row lands on the same weekday as the same date with a time on it", () => {
  // THE BUG, in one line: `new Date(t.dateTime).getDay()` returned Saturday for
  // the date-only row and Sunday for the timed one, for the same calendar day.
  // The importer does not validate the shape (safeStr only), so date-only rows
  // are legal and every By-weekday reading shipped with them a day out.
  assert.equal(dowOf(trade({ dateTime: "2026-08-02" })), 0, "2026-08-02 is a Sunday");
  assert.equal(dowOf(trade({ dateTime: "2026-08-02T09:30" })), 0);
  for (const d of ["2026-08-02", "2026-08-03", "2026-08-04", "2026-12-31", "2026-01-01"]) {
    assert.equal(dowOf(trade({ dateTime: d })), dowOf(trade({ dateTime: d + "T13:45" })),
      d + " must read the same weekday with and without a time");
  }
});

test("an unusable date is null, not a silent zero", () => {
  // null routes the trade to the coverage count; 0 would file it under Sunday.
  for (const bad of ["", "nonsense", "2026-08", "20260802", null, undefined]) {
    assert.equal(dowOf(trade({ dateTime: bad })), null, JSON.stringify(bad) + " must be null");
  }
});

// ---------------------------------------------------------------------------
// Hours
// ---------------------------------------------------------------------------

test("the entry hour is read off the string, and a row with no time is null", () => {
  assert.equal(hourOf(trade({ dateTime: "2026-08-02T09:30" })), 9);
  assert.equal(hourOf(trade({ dateTime: "2026-08-02T00:00" })), 0);
  assert.equal(hourOf(trade({ dateTime: "2026-08-02T23:59" })), 23);
  assert.equal(hourOf(trade({ dateTime: "2026-08-02" })), null, "a date with no time carries no hour");
  assert.equal(hourOf(trade({ dateTime: "2026-08-02X09:30" })), null, "the T separator is the contract");
});

test("an hour is labelled as the range it is, and wraps at midnight", () => {
  assert.equal(hourLabel(9), "09:00-10:00");
  assert.equal(hourLabel(0), "00:00-01:00");
  assert.equal(hourLabel(23), "23:00-00:00", "the last hour of the day must not read 23:00-24:00");
});

// ---------------------------------------------------------------------------
// Coverage - the gap is NAMED, never quietly dropped
// ---------------------------------------------------------------------------

const timed = (h, r, day = "01") => trade({
  dateTime: "2026-06-" + day + "T" + String(h).padStart(2, "0") + ":15", R: r, Rmanual: true, riskAmt: 100, pnl: r * 100,
});

test("trades an axis cannot place are counted, not filtered away", () => {
  const list = [
    timed(9, 1), timed(9, -1), timed(10, 2),
    trade({ dateTime: "2026-06-01", R: 1, Rmanual: true }),      // no time
    trade({ dateTime: "2026-06-02", R: -1, Rmanual: true }),     // no time
  ];
  const { rows, uncovered } = timeBuckets(list, hourKey);
  assert.equal(uncovered, 2, "the two timeless rows must be reported, not vanish");
  const placed = rows.reduce((a, r) => a + r.n, 0);
  assert.equal(placed + uncovered, 5, "every resolved trade is either placed or named as a gap");

  // THE BUG THIS REPLACES: the old table did
  //   list.filter(t => (t.dateTime||"").length >= 16)
  // before it ever counted, so a record where 40% of rows had no time looked
  // complete. If uncovered is ever computed as 0 here, that filter is back.
  assert.notEqual(uncovered, 0);
});

test("a trade with no measurable risk basis never reaches a bucket", () => {
  // Trap #2: computeRraw's last branch invents +-1R from sign(pnl). A bucket
  // built without hasRBasis fills with fabricated R.
  const list = [
    timed(9, 1),
    trade({ dateTime: "2026-06-01T09:15", riskAmt: null, pnl: 250, entry: null, stop: null, R: null, Rmanual: false }),
  ];
  const { rows, uncovered } = timeBuckets(list, hourKey);
  assert.equal(rows.reduce((a, r) => a + r.n, 0), 1, "only the trade with a real risk basis is counted");
  assert.equal(uncovered, 0, "and the fabricated one is not a COVERAGE gap either - it is out of scope entirely");
});

// ---------------------------------------------------------------------------
// Ordering - by the axis, never by R
// ---------------------------------------------------------------------------

test("hours come back in clock order even when the worst hour is first", () => {
  // 08:00 is the big winner and 15:00 the big loser. Sorted by R - which is what
  // breakdownBy did, and what this replaced - 08:00 would lead and 15:00 trail.
  const list = [
    timed(15, -2), timed(15, -2), timed(11, 0.5), timed(8, 5), timed(8, 5), timed(9, 1),
  ];
  const { rows } = timeBuckets(list, hourKey);
  assert.deepEqual(rows.map((r) => r.k), ["08:00-09:00", "09:00-10:00", "11:00-12:00", "15:00-16:00"]);
  assert.ok(rows.every((r, i) => i === 0 || rows[i - 1].ord < r.ord), "ord must be strictly increasing");
});

test("weekdays come back Monday first, not sorted by R", () => {
  // 2026-06-01 is a Monday, so 01..07 is Mon..Sun.
  const list = [];
  ["07", "05", "01", "03"].forEach((d, i) => {
    list.push(trade({ dateTime: "2026-06-" + d + "T09:15", R: 10 - i * 5, Rmanual: true, riskAmt: 100, pnl: 100 }));
  });
  const { rows } = timeBuckets(list, dowKey);
  assert.deepEqual(rows.map((r) => r.k), ["Mon", "Wed", "Fri", "Sun"],
    "Sunday is the END of a trading week, and R must not reorder any of it");
});

test("holding-time buckets run short to long", () => {
  assert.deepEqual([2, 9, 30, 120, 900].map((m) => durBucket(m).k),
    ["under 5m", "5-15m", "15-60m", "1-4h", "over 4h"]);
  assert.deepEqual([2, 9, 30, 120, 900].map((m) => durBucket(m).ord), [0, 1, 2, 3, 4]);
  // the boundaries themselves, which is where an off-by-one lives
  assert.equal(durBucket(5).k, "5-15m");
  assert.equal(durBucket(15).k, "15-60m");
  assert.equal(durBucket(60).k, "1-4h");
  assert.equal(durBucket(240).k, "over 4h");
});

// ---------------------------------------------------------------------------
// Sequence within a day
// ---------------------------------------------------------------------------

test("trade-of-the-day ordering breaks same-minute ties on createdAt", () => {
  // dateTime only carries MINUTE resolution, so two trades in one minute order
  // arbitrarily without the createdAt tiebreak - the same comparator statsDeep
  // uses. Deliberately inserted out of order.
  const list = [
    trade({ id: "b", dateTime: "2026-06-01T09:15", createdAt: 200 }),
    trade({ id: "c", dateTime: "2026-06-01T11:00", createdAt: 50 }),
    trade({ id: "a", dateTime: "2026-06-01T09:15", createdAt: 100 }),
    trade({ id: "z", dateTime: "2026-06-02T09:15", createdAt: 999 }),
  ];
  const ord = dayOrdinals(list);
  assert.equal(ord.a, 1, "earlier createdAt wins the same minute");
  assert.equal(ord.b, 2);
  assert.equal(ord.c, 3, "a later clock time still sorts after both, whatever createdAt says");
  assert.equal(ord.z, 1, "a new day restarts the count");
});

test("post-loss latency measures losing EXIT to next ENTRY, per account", () => {
  const L = (over) => trade({ R: -1, Rmanual: true, riskAmt: 100, pnl: -100, ...over });
  const W = (over) => trade({ R: 2, Rmanual: true, riskAmt: 100, pnl: 200, ...over });
  const list = [
    L({ id: "loss", dateTime: "2026-06-01T09:00", exitTime: "2026-06-01T09:30", account: "A" }),
    W({ id: "next", dateTime: "2026-06-01T09:40", account: "A" }),
    W({ id: "afterwin", dateTime: "2026-06-01T10:00", account: "A" }),
    W({ id: "other", dateTime: "2026-06-01T09:35", account: "B" }),
  ];
  const g = postLossGaps(list);
  assert.equal(g.next, 10, "09:30 exit to 09:40 entry is ten minutes");
  assert.equal(g.afterwin, undefined, "a trade following a WINNER carries no post-loss gap");
  assert.equal(g.other, undefined, "account B never followed account A's loss - two accounts are not one sequence");
  assert.equal(g.loss, undefined, "the losing trade itself is not after itself");
});

test("a losing trade with no exit time dates nothing", () => {
  const list = [
    trade({ id: "loss", dateTime: "2026-06-01T09:00", exitTime: null, R: -1, Rmanual: true, riskAmt: 100, pnl: -100 }),
    trade({ id: "next", dateTime: "2026-06-01T09:40" }),
  ];
  assert.equal(postLossGaps(list).next, undefined, "without an exit time there is no gap to measure");
});

test("days are bucketed by how many trades were taken on them", () => {
  const on = (day, n) => Array.from({ length: n }, (_, i) =>
    trade({ id: day + "_" + i, dateTime: "2026-06-" + day + "T0" + (9 + i) + ":15", R: 1, Rmanual: true, riskAmt: 100, pnl: 100 }));
  const rows = dayCountRows([...on("01", 1), ...on("02", 2), ...on("03", 2), ...on("04", 7)]);
  assert.deepEqual(rows.map((r) => r.k), ["1 trade", "2 trades", "5+ trades"]);
  assert.deepEqual(rows.map((r) => r.days), [1, 2, 1]);
  assert.equal(rows[2].totR, 7, "the seven-trade day contributes its whole day total");
  assert.ok(rows.every((r) => r.green === r.days), "every day here is green");
});

// ---------------------------------------------------------------------------
// THE TWO BARS. This is the part that can do damage if it is wrong.
// ---------------------------------------------------------------------------

// A record with NO timing signal by construction: the R multiples are fixed, and
// which hour each one lands in is decided by a seeded PRNG that never looks at R.
function noSignal(seed, n = 90, hours = 8) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return Array.from({ length: n }, (_, i) => {
    const r = i % 5 === 0 ? 2.2 : i % 3 === 0 ? -1 : i % 2 === 0 ? 1.4 : -1;
    const h = 8 + ((rnd() * hours) | 0);
    return timed(h, r, String(1 + (i % 20)).padStart(2, "0"));
  });
}

test("a scan over buckets with no timing signal in them does not call one real", () => {
  // THE MEASUREMENT THIS FEATURE TURNS ON. journal.ts's counterfactual note
  // records that on 60 such records the bootstrap band ALONE called 13 real -
  // ~78% coverage against a nominal 90% - and that both bars together called 0.
  // This is the same null on the timing axes. If it ever starts firing, the
  // multiplicity correction has come loose and the tab is issuing instructions
  // out of noise.
  let fired = 0;
  const R = 40;
  for (let s = 1; s <= R; s++) {
    const list = noSignal(s * 7717);
    const hours = timeBuckets(list, hourKey);
    const sep = separability([{ axis: "entry hour", rows: hours.rows }]);
    if (sep.best && sep.best.st.separable) fired++;
  }
  assert.ok(fired <= 2, "at most a nominal-rate slip out of " + R + " pure-noise records, got " + fired);
});

test("the noise floor is what stops it, not the band alone", () => {
  // Trap #19, made structural: if the second bar were removed, THIS is the
  // assertion that would go red. On the same null records the band on its own
  // has to let materially more through than both bars together - otherwise the
  // floor is doing nothing and the test above proves nothing either.
  let bandOnly = 0, both = 0;
  for (let s = 1; s <= 40; s++) {
    const hours = timeBuckets(noSignal(s * 7717), hourKey);
    const sep = separability([{ axis: "entry hour", rows: hours.rows }]);
    if (!sep.best) continue;
    const st = sep.best.st;
    if (st.dLo > 0 || st.dHi < 0) bandOnly++;
    if (st.separable) both++;
  }
  assert.ok(bandOnly > both,
    "the band alone must be the looser bar (band " + bandOnly + " vs both " + both + ") - if they are equal the noise floor is inert");
});

test("a planted hour edge big enough to matter does clear both bars", () => {
  // A bar nothing can ever clear is not a bar, it is an off switch. One hour is
  // given a materially better distribution over enough trades to be seen.
  // The planted hour is a MINORITY of the record on purpose. A bucket holding
  // half the trades drags the grand mean toward itself, which shrinks its own
  // deviation and inflates everyone else's - the first draft of this fixture
  // named 10:00 as the most striking bucket for exactly that reason.
  const list = [];
  for (let i = 0; i < 24; i++) {
    list.push(timed(9, i % 4 === 0 ? -1 : 3.0, String(1 + (i % 20)).padStart(2, "0")));  // ~ +2.0R
  }
  for (let i = 0; i < 100; i++) {
    list.push(timed(10 + (i % 5), i % 2 === 0 ? -1 : 1.0, String(1 + (i % 20)).padStart(2, "0")));  // ~ 0R
  }
  const hours = timeBuckets(list, hourKey);
  const sep = separability([{ axis: "entry hour", rows: hours.rows }]);
  assert.ok(sep.best, "there is a most-striking bucket");
  assert.equal(sep.best.row.k, "09:00-10:00", "and it is the planted one");
  assert.ok(sep.best.st.separable, "a real, large, well-sampled gap must be callable");
  assert.ok(sep.best.st.dLo > 0, "its band must sit clear of zero");
  assert.ok(Math.abs(sep.best.st.d) > sep.best.st.noise, "and clear of the scan floor");
});

test("the multiplicity correction counts every bucket on the screen, not one axis", () => {
  // The trader is looking at all the tables at once. Correcting each axis for its
  // own bucket count would be four uncorrected looks wearing a correction.
  const list = noSignal(4242, 120, 6);
  const hours = timeBuckets(list, hourKey);
  const dows = timeBuckets(list, dowKey);
  const one = separability([{ axis: "entry hour", rows: hours.rows }]);
  const two = separability([{ axis: "entry hour", rows: hours.rows }, { axis: "weekday", rows: dows.rows }]);
  assert.ok(two.choices > one.choices, "adding an axis must widen the scan, got " + two.choices + " vs " + one.choices);
  assert.ok(two.best.st.noise >= one.best.st.noise,
    "and a wider scan can only raise the floor, never lower it");
});

test("a bucket under the house floor is not eligible and does not inflate the scan", () => {
  // n>=4 is the bar every other table in this app already draws at. A bucket
  // below it was never in the running, so counting it as a "choice" would
  // overstate the correction and hide a real finding.
  const list = [];
  for (let i = 0; i < 40; i++) list.push(timed(9, i % 2 ? 1 : -1, String(1 + (i % 20)).padStart(2, "0")));
  for (let i = 0; i < 40; i++) list.push(timed(10, i % 2 ? 1 : -1, String(1 + (i % 20)).padStart(2, "0")));
  list.push(timed(3, 9, "05"));  // a single wild trade in its own hour
  const hours = timeBuckets(list, hourKey);
  assert.equal(hours.rows.length, 3, "the lone trade still gets a ROW - it is real and it is in the total");
  const sep = separability([{ axis: "entry hour", rows: hours.rows }]);
  assert.equal(sep.choices, 2, "but only the two 4+ buckets were ever pickable");
  assert.notEqual(sep.best.row.k, "03:00-04:00", "and the one-trade hour cannot be named the most striking");
});

test("an ENDOGENOUS axis sails through both bars - which is why holding time is not tested", () => {
  // Caught on a demo record, not by reasoning: the tab announced "1-4h separates,
  // +1.50R against -0.45R, both bars cleared" on a fixture where holding time
  // carried no information whatsoever. It cannot carry any. A winner runs to its
  // target and is therefore held for hours; a loser hits its stop in minutes. The
  // bucket is ASSIGNED BY THE OUTCOME.
  //
  // No bootstrap and no permutation floor can see this, and this test exists to
  // say so out loud: the association is real, it is just backwards, and both bars
  // correctly report a real association. The fix is not a better statistic, it is
  // refusing to put the axis in - `separability` is only ever handed axes you can
  // choose BEFORE the trade (hour, weekday, trade-of-day, wait-after-a-loss).
  //
  // If this test ever goes GREEN-as-in-"not separable", do not celebrate: it
  // means the bars got weaker, not that the axis got safer.
  const mk = (k, ord, rs) => ({ k, ord, rs, n: rs.length, exp: rs.reduce((a, b) => a + b, 0) / rs.length });
  const dims = [{
    axis: "holding time",
    rows: [
      mk("under 5m", 0, Array.from({ length: 40 }, () => -1)),      // every loser: stopped fast
      mk("1-4h", 3, Array.from({ length: 30 }, () => 1.5)),          // every winner: ran to target
      mk("15-60m", 2, Array.from({ length: 12 }, (_, i) => (i % 3 ? -1 : 1.5))),
    ],
  }];
  const sep = separability(dims);
  assert.ok(sep.best, "there is a most striking bucket");
  assert.ok(sep.best.st.separable,
    "an outcome-assigned axis clears both bars trivially - that is the hazard, and it is why the renderer must not offer this axis to separability()");
});

test("separability declines rather than guesses on a record under the counterfactual floor", () => {
  const list = [];
  for (let i = 0; i < CUT_MIN_N - 5; i++) list.push(timed(9 + (i % 3), i % 2 ? 1 : -1, "0" + (1 + (i % 5))));
  const sep = separability([{ axis: "entry hour", rows: timeBuckets(list, hourKey).rows }]);
  assert.equal(sep.best, null, "under " + CUT_MIN_N + " trades on an axis there is nothing to say");
});
