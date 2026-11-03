// The slider edge's inputs, and the Validate verdict that reads them.
//
//   1. EXACT INPUTS. The number box is the input of record. The model used to
//      read the range slider, which snaps to its step: a typed 92 trades became
//      90, a 0.84 R:R became 0.85 and a 1.09 profit factor became 1.10. These
//      pin that edgeFromInputs keeps every typed value, and that the domain - a
//      loop bound for `n` (Trap #22) - is enforced here, not on the element.
//   2. THE VERDICT. The interval decides; the average never does. A range that
//      spans zero must never be headlined as promising, real or green.
import test from "node:test";
import assert from "node:assert/strict";
import { installDom } from "./env.mjs";
import { buildOnce } from "./build.mjs";

installDom();
const E = await import(await buildOnce("edgeinputs"));
const { S, edgeFromInputs, fmtPay, EDGE_BOUNDS, edgeVerdict, expectancy, sigmaR, profitFactor, zFor, PLAN_MIN_N } = E;

const rr = (o) => edgeFromInputs({ wr: 56, pay: 1, payMode: "rr", sc: 0, n: 120, ...o });

// ---------------------------------------------------------------------------
// 1. exact inputs
// ---------------------------------------------------------------------------

test("the values the user typed reach the model unrounded: 92 trades, 0.84 R, 1.09 PF", () => {
  assert.equal(rr({ n: 92 }).n, 92);
  assert.equal(rr({ pay: 0.84 }).b, 0.84);
  // profit factor: the edge modelled must have exactly the PF typed
  const e = edgeFromInputs({ wr: 56, pay: 1.09, payMode: "pf", sc: 2, n: 92 });
  Object.assign(S, { p: e.p, b: e.b, s: e.s, n: e.n, trades: null, meta: null });
  assert.ok(Math.abs(profitFactor() - 1.09) < 1e-12, "PF " + profitFactor());
  assert.equal(S.n, 92);
});

test("off-step values in every field survive - nothing snaps to a slider step", () => {
  for (const n of [11, 92, 101, 999, 1499]) assert.equal(rr({ n }).n, n);
  for (const pay of [0.51, 0.84, 1.07, 2.33, 5.99]) assert.equal(rr({ pay }).b, pay);
  assert.equal(rr({ wr: 55.5 }).p, 0.555);
  assert.equal(rr({ sc: 2.5 }).s, 0.025);
});

test("trades is a count: a fractional entry rounds to a whole trade", () => {
  assert.equal(rr({ n: 92.4 }).n, 92);
  assert.equal(rr({ n: 92.6 }).n, 93);
});

test("the domain is enforced at the model boundary - n is a loop bound (Trap #22)", () => {
  assert.equal(rr({ n: 1e7 }).n, EDGE_BOUNDS.n[1]);
  assert.equal(rr({ n: Infinity }).n, EDGE_BOUNDS.n[1]);
  assert.equal(rr({ n: NaN }).n, EDGE_BOUNDS.n[0]);
  assert.equal(rr({ n: -5 }).n, EDGE_BOUNDS.n[0]);
  assert.equal(rr({ wr: 250 }).p, 1);
  assert.equal(rr({ sc: 99 }).s, EDGE_BOUNDS.sc[1] / 100);
  assert.equal(rr({ pay: 1e9 }).b, EDGE_BOUNDS.rr[1]);
  assert.ok(rr({ pay: NaN }).b >= 0.05);
});

test("switching R:R -> PF -> R:R returns the number that was typed", () => {
  for (const wr of [35, 48, 56, 62.5, 70]) {
    for (const r of [0.5, 0.84, 0.85, 1.09, 1.5, 2.37, 3]) {
      const p = wr / 100;
      const pf = Number(fmtPay((p / (1 - p)) * r));
      const back = fmtPay((pf * (1 - p)) / p);
      assert.equal(Number(Number(back).toFixed(2)), r, wr + "% " + r + "R -> PF " + pf + " -> " + back);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. the verdict
// ---------------------------------------------------------------------------

const verdictFor = (inp) => {
  const e = edgeFromInputs(inp);
  Object.assign(S, { p: e.p, b: e.b, s: e.s, n: e.n, trades: null, meta: null });
  const conf = 0.95, z = zFor(conf), mu = expectancy(), seE = sigmaR() / Math.sqrt(e.n);
  return { v: edgeVerdict({ mu, seE, z, n: e.n, nEff: e.n, conf }), mu, lo: mu - z * seE, hi: mu + z * seE };
};

test("the user's record (56%, 0.85R, 2% scratch, 90 trades) is ruled 'No proven edge', not 'promising'", () => {
  const { v, mu, lo, hi } = verdictFor({ wr: 56, pay: 0.85, payMode: "rr", sc: 2, n: 90 });
  assert.ok(mu > 0 && lo < 0 && hi > 0, "the fixture must span zero");
  assert.equal(v.headline, "No proven edge");
  assert.equal(v.tone, "wait");
  assert.doesNotMatch(v.headline + v.chip + v.read, /promising|real|likely|can.t tell/i);
  // a +0.04R edge with ~0.9R spread takes thousands of trades to show
  assert.ok(v.need > 1000 && v.need < 4000, "need " + v.need);
  assert.match(v.read, /includes losing/);
  assert.match(v.read, /\u22120\.15R to \+0\.2\dR/, "the reason quotes the record's own range: " + v.read);
});

test("an interval crossing zero NEVER reads promising, real or green, and is never 'proven' losing - over a grid", () => {
  let crossing = 0;
  for (let mu = -0.3; mu <= 0.3; mu += 0.01) {
    for (const seE of [0.02, 0.05, 0.1, 0.2]) {
      for (const n of [30, 90, 400, 1500]) {
        const z = 1.96, lo = mu - z * seE, hi = mu + z * seE;
        if (!(lo <= 0 && hi >= 0)) continue;
        crossing++;
        const v = edgeVerdict({ mu, seE, z, n, nEff: n, conf: 0.95 });
        assert.doesNotMatch(v.headline + " " + v.chip + " " + v.read, /promising|real|holds up|losing strategy/i, JSON.stringify({ mu, seE, n, v }));
        assert.notEqual(v.tone, "go");
        // a positive average inside the noise is amber; an average at or below zero is red
        assert.equal(v.tone, mu > 0.001 ? "wait" : "stop", JSON.stringify({ mu, seE, n, v }));
        assert.equal(v.headline, mu > 0.001 ? "No proven edge" : "No edge");
      }
    }
  }
  assert.ok(crossing > 100, "the grid must actually exercise the crossing case (" + crossing + ")");
});

test("the tiers: above zero is real, below zero is losing, under 30 trades holds back", () => {
  const up = edgeVerdict({ mu: 0.3, seE: 0.05, z: 1.96, n: 400, nEff: 400, conf: 0.95 });
  assert.equal(up.headline, "Edge holds up"); assert.equal(up.tone, "go");
  const down = edgeVerdict({ mu: -0.3, seE: 0.05, z: 1.96, n: 400, nEff: 400, conf: 0.95 });
  assert.equal(down.headline, "Losing strategy"); assert.equal(down.tone, "stop");
  const flat = edgeVerdict({ mu: -0.02, seE: 0.05, z: 1.96, n: 400, nEff: 400, conf: 0.95 });
  assert.equal(flat.headline, "No edge"); assert.equal(flat.tone, "stop");
  // the sample-size bar comes first, even over a range that clears zero
  const thin = edgeVerdict({ mu: 0.5, seE: 0.05, z: 1.96, n: PLAN_MIN_N - 1, nEff: PLAN_MIN_N - 1, conf: 0.95 });
  assert.equal(thin.headline, "Too few trades"); assert.notEqual(thin.tone, "go");
  // and the chosen confidence is quoted, not a hardcoded 95
  assert.match(edgeVerdict({ mu: 0.3, seE: 0.05, z: 2.5, n: 400, nEff: 400, conf: 0.9875 }).read, /98\.8%/);
});

test("'trades to show it' is the count at which the range would just clear zero", () => {
  const mu = 0.1, sd = 1, n = 100, z = 1.96;
  const v = edgeVerdict({ mu, seE: sd / Math.sqrt(n), z, n, nEff: n, conf: 0.95 });
  // (z*sd/mu)^2 = 384.16 -> 385
  assert.equal(v.need, 385);
  assert.ok(mu - z * sd / Math.sqrt(v.need) > 0, "at `need` the range clears zero");
  assert.ok(mu - z * sd / Math.sqrt(v.need - 1) <= 0, "one trade fewer it does not");
  // a clustered record (fewer independent trades than logged) needs more logged trades
  const clustered = edgeVerdict({ mu, seE: sd / Math.sqrt(50), z, n, nEff: 50, conf: 0.95 });
  assert.equal(clustered.need, Math.ceil(384.16 * 2));
});
