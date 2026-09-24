// "My firm": the join between the journal's BOUND firm and the Simulator's
// sizing optimisers.
//
// WHY THIS FILE EXISTS. Before it, `grep -c "profitPlateau\|fundedCurve\|
// costPlateau" src/journal.ts` returned 0. The journal knew *your firm* (bound
// per account) and *your odds* (resampled from your own trades); sim.ts knew
// *how to size*. Nothing joined them, so a trader who had already chosen a firm
// got odds but never got a size - and the sizing advice that did exist lived on
// a tab driven by sliders and by the SIMULATOR's firm, which may be a different
// firm entirely.
//
// TWO SCREENS, ONE RULE. The sizing rules below were lifted OUT of sim.ts
// rather than copied: renderFunded and evalAdvice now call the same functions
// this file gives the journal. That is deliberate and load-bearing - this app
// has been bitten repeatedly by one quantity computed twice (the 500-vs-750
// "1st-yr payout", the two win-rate CIs, the two cost models), and a "best size"
// reading 0.46% on the Funded tab and 0.58% under My firm would be the same
// class of bug. Same grid, same tolerance, same bars, same sim counts: where the
// firm and the edge agree, the two screens are bit-identical.
//
// EVERYTHING HERE RUNS INSIDE withFirm/withEdge. The engine reads the F and S
// singletons, so scoring a BOUND firm from the journal without swapping them in
// would silently re-price every other tab (Trap #10). Nothing in this file
// touches F or S outside those wrappers.
import { Firm, withFirm, withEdge } from "./state";
import { mulberry, runJob } from "./util";
import {
  challengeCurve, costPlateau, expectancy, fundedCurve, profitPlateau,
  payoutOdds, PAID_SIMS, PAY_CHUNK, yearSteps, EvalPoint,
} from "./engine";

// ---------------------------------------------------------------------------
// The shared sizing vocabulary. sim.ts imports these; so does buildPlan below.
// ---------------------------------------------------------------------------

// The one risk grid, shared by the funded curve, the eval curve and the plan.
// To 3.0 because every risk slider goes there, and the "your size" marker used
// to pin silently at an old 2.5% right edge for anything above it.
export function riskGrid(): number[] {
  const risks: number[] = [];
  for (let r = 0.1; r <= 3.0001; r += 0.12) risks.push(r);
  return risks;
}

// A plateau is "within 3% of the best". One constant, because the funded curve,
// the eval curve and the payout-goal curve all quote that same phrase on screen.
export const PLATEAU_TOL = 0.03;
// The survival bar this app already commits to when it colours the Survival tile
// green. Any size it names has to clear it.
export const SAFE_SURV = 0.85;
// The end-to-end pass rate the Challenge tab already calls "Strong".
export const PASS_BAR = 0.85;
// Below this many resolved trades the app refuses to name a SINGLE SIZE. Validate
// refuses to call an edge real here, the Funded tab's sizing tile refuses here,
// and the counterfactual declines here. A plan derived from 22 trades is a guess
// wearing a number.
//
// What it never meant, and what My firm read it as for one release, is "print
// nothing". Validate does not go blank under 30 - it relabels its verdict chip
// and still prints every interval it has. The Funded tab blanks ONE TILE. The bar
// is on the instruction, not on the screen.
export const PLAN_MIN_N = 30;
// ...and below THIS, not even a range. Matches the journal's Prop odds panel,
// which has bootstrapped this same record end to end from 10 since it shipped.
// Between the two the app names a RANGE and never a point inside it.
export const PLAN_BAND_MIN_N = 10;

// Sim counts. Identical to the Funded tab's full-quality pass and the Decision
// tab's eval curve, so a plan and a slider read the same number for the same
// firm and edge. A FAST tier may cut counts on a DRAG; nothing drags here.
export const PLAN_FUND_SIMS = 240;
export const PLAN_EVAL_SIMS = 400;

export interface FundedPick {
  flat: { pk: number; lo: number; hi: number };
  inPlateau: number;   // largest size INSIDE the plateau clearing SAFE_SURV, or -1
  anywhere: number;    // largest size ANYWHERE on the grid clearing it, or -1
}
// THE FUNDED SIZING RULE, in one place (commit 3a3e9ec).
//
// "Best size" used to be a profit maximum with survival deleted - it recommended
// sizes where 39 accounts in 100 survived the year, because profitPlateau read
// prof[] and nothing ever read surv[], which sits in the same object. The rule
// is now: the LARGEST size inside the profit plateau that still clears the 85%
// survival bar. Largest, not smallest, because inside the plateau profit is flat
// by construction, so the only thing left to spend is risk of ruin.
//
// It returns INDICES and never a sentence: the caller owns the copy, and the
// caller must always print the survival number beside the size. "No
// recommendation without its survival cost" is a project rule, kept structurally
// - by this function refusing to hand back a size on its own.
export function pickFundedSize(prof: number[], surv: number[]): FundedPick {
  const flat = prof.length ? profitPlateau(prof, PLATEAU_TOL) : { pk: 0, lo: 0, hi: 0 };
  const lastSafe = (from: number, to: number) => {
    for (let i = to; i >= from; i--) if ((surv[i] ?? 0) >= SAFE_SURV) return i;
    return -1;
  };
  return {
    flat,
    inPlateau: prof.length ? lastSafe(flat.lo, flat.hi) : -1,
    anywhere: prof.length ? lastSafe(0, prof.length - 1) : -1,
  };
}

export interface EvalPick {
  pl: { pk: number; lo: number; hi: number };
  pick: number;      // the index this app names
  barMet: boolean;   // ...and whether it clears PASS_BAR, or is only the best available
}
// THE EVAL SIZING RULE, in one place (commit 1987ec2).
//
// Inside the cost band the money is flat by construction, so naming its cheapest
// POINT answers a question that has no answer. What is not flat is the clock,
// and a MONTHLY firm is where that shows: its cost quantises to whole billing
// months, so the band can run 0.30%-2.90% at an identical $165 while the
// single-attempt pass rate falls 98% to 58%. Same shape as the funded rule
// therefore: flat objective, then a bar, then the extreme that clears it - the
// QUICKEST size in the band that still passes 85 attempts in 100. If nothing in
// the band clears it, fall back to the likeliest to land rather than the fastest.
export function pickEvalSize(pts: EvalPoint[]): EvalPick {
  const pl = costPlateau(pts.map((p) => p.cost), PLATEAU_TOL);
  let pick = -1;
  for (let i = pl.lo; i <= pl.hi; i++) {
    if (pts[i].pass < PASS_BAR) continue;
    if (pick < 0 || pts[i].days < pts[pick].days) pick = i;
  }
  const barMet = pick >= 0;
  if (!barMet) { pick = pl.lo; for (let i = pl.lo + 1; i <= pl.hi; i++) if (pts[i].pass > pts[pick].pass) pick = i; }
  return { pl, pick, barMet };
}

// ---------------------------------------------------------------------------
// THE EDGE BAND - parameter uncertainty, for every tab rather than just Validate
// ---------------------------------------------------------------------------
//
// Validate spends its whole screen establishing that the edge is real WITHIN A
// RANGE, and then every other tab consumed the point estimate. Measured on the
// reference record, the end-to-end pass rate runs 97% at the point estimate and
// 77% at the low end of the same 95% win-rate interval the tab prints one click
// away - a one-in-four failure rate presented as one-in-thirty-three. Survival
// and net EV inherit the same gap.
//
// No engine change and no anchored number moves, because a band is built by
// calling the EXISTING functions on a resampled record - which is exactly what
// the journal's odds panel has always done. This is that loop, lifted somewhere
// both halves of the app can reach.
export interface Band { lo: number; mid: number; hi: number; n: number }

// One resample of the record, with replacement. Seeded by draw index so a band
// is deterministic: the same record and firm give the same range every time,
// which is the property that lets a user tell a real change from a re-roll.
export function resampleRecord(rs: number[], seed: number): number[] {
  const rnd = mulberry(seed);
  const out = new Array<number>(rs.length);
  for (let i = 0; i < rs.length; i++) out[i] = rs[(rnd() * rs.length) | 0];
  return out;
}
export function bandOf(vals: number[], conf = 0.9): Band {
  const s = vals.filter((v) => isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return { lo: 0, mid: 0, hi: 0, n: 0 };
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * p)))];
  const tail = (1 - conf) / 2;
  return { lo: q(tail), mid: q(0.5), hi: q(1 - tail), n: s.length };
}
// Formats a band the way every tab should: the point estimate stays the
// headline, the range goes underneath. A band printed AS the headline would
// swap one over-confident number for one nobody can act on.
export function bandText(b: Band, fmt: (v: number) => string): string {
  return b.n ? "90% range " + fmt(b.lo) + "&ndash;" + fmt(b.hi) : "";
}

// ---------------------------------------------------------------------------
// THE SIZE BAND - what "too thin to size" turns into instead of a blank panel
// ---------------------------------------------------------------------------
//
// Between PLAN_BAND_MIN_N and PLAN_MIN_N the honest answer to "how big" is a
// range, and the range is built the only way this app builds one: resample the
// record and ask the SAME sizing rule what it would have named. No new
// statistics, no second sizing rule to drift from the first.
//
// QUALITY IS SPLIT ON PURPOSE. These draws run a coarse grid and a reduced sim
// count; the point estimate the tile prints always comes from buildPlan's own
// full-quality pass, and only lo/hi come from here. ensureBands() on the
// Simulator already works exactly this way. What does NOT drop is the horizon -
// yearSteps() is the one year this app has (Trap #14) - only the sim count.
export const PLAN_BAND_DRAWS = 60;
export const PLAN_BAND_SIMS = 120;
// Every third grid point. The question is how far the SIZE moves when the record
// is resampled, and that does not need the full grid's 0.12% resolution.
export function bandGrid(): number[] {
  const all = riskGrid(), out: number[] = [];
  for (let i = 0; i < all.length; i += 3) out.push(all[i]);
  return out;
}

// The size a funded curve names, as a risk %. Pulled out of buildPlan so a band
// draw and the point it is a band around cannot use two different rules.
export function sizeFromCurve(risks: number[], prof: number[], surv: number[]): number {
  const p = pickFundedSize(prof, surv);
  const i = p.inPlateau >= 0 ? p.inPlateau : p.anywhere >= 0 ? p.anywhere : p.flat.lo;
  return risks[i] ?? risks[0];
}

// ONE draw of the size band. Synchronous and pure so a test can call it directly;
// buildPlan queues PLAN_BAND_DRAWS of them, one per macrotask.
//
// A draw with no edge in it contributes 0 rather than its least-bad size, and
// that is deliberate: if a tenth of the records this record could have been carry
// no safe size at all, the low end of the band has to say so. Averaging over the
// possibility instead would be the same defect as pricing an unpriceable trade at
// $0 (Trap #21) - a number standing in for the absence of one.
export function bandDraw(firm: Firm, rs: number[], seed: number): number {
  const risks = bandGrid();
  const draw = resampleRecord(rs, seed);
  const c = withFirm(firm, () => withEdge(draw, () => fundedCurve(risks, PLAN_BAND_SIMS, yearSteps())));
  const mu = withEdge(draw, () => expectancy());
  const pick = pickFundedSize(c.prof, c.surv);
  if (mu <= 0 || (c.prof[pick.flat.pk] || 0) < 1) return 0;
  return sizeFromCurve(risks, c.prof, c.surv);
}

// firstPayoutPct() in the engine reads the F singleton; this is the same
// definition applied to a firm handed in, so the plan can measure a BOUND firm
// without swapping F for a one-line arithmetic question.
export function firstPayoutPctOf(f: Firm): number {
  const minPct = f.account > 0 ? ((f.payoutMin || 0) / f.account) * 100 : 0;
  return Math.max(PAY_CHUNK, minPct);
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

// Which payout gates this firm actually carries. One list, so the readings and
// the leave-one-out attribution below cannot disagree about what "gated" means.
export function activeGates(f: Firm): string[] {
  const on: string[] = [];
  if ((f.payoutBuffer || 0) > 0) on.push("buffer");
  if ((f.payoutCap || 0) > 0) on.push("cap%");
  if ((f.payoutCapAmt || 0) > 0) on.push("cap$");
  if ((f.payoutCons || 0) > 0) on.push("cons");
  if ((f.winDays || 0) > 0) on.push("windays");
  if ((f.payoutMin || 0) > 0) on.push("min");
  if ((f.payoutFirst || 0) > 0) on.push("first");
  return on;
}
// the same firm with ONE gate switched off, for the leave-one-out cost below
function withoutGate(f: Firm, key: string): Firm {
  const g: Firm = { ...f };
  if (key === "buffer") g.payoutBuffer = 0;
  else if (key === "cap%") g.payoutCap = 0;
  else if (key === "cap$") g.payoutCapAmt = 0;
  else if (key === "cons") g.payoutCons = 0;
  else if (key === "windays") { g.winDays = 0; g.winAmt = 0; }
  else if (key === "min") g.payoutMin = 0;
  else if (key === "first") g.payoutFirst = 0;
  return g;
}

export interface GateRead {
  key: string;
  rule: string;      // the firm's own rule, in words, from its own fields
  reading: string;   // what it does to THIS plan, measured on THIS record
  tone: "" | "cell-go" | "cell-caution" | "cell-stop";
  // The SIGNED effect of this gate on the odds of a first payout, in points, and
  // on the median trading days to reach it. Negative odds / positive days = the
  // gate costs you. null where the quantity is not separable.
  dOdds: number | null;
  dDays: number | null;
}

// One trading day of the user's own record: the date and the day's total R.
// Supplied by the journal (which owns the trades); this file never imports it,
// because journal.ts imports THIS file.
export interface DayR { day: string; r: number }

export interface PlanInput {
  firm: Firm;
  rs: number[];          // the account's R multiples, in entry order
  days: DayR[];          // the account's trading days, in date order
  phase: "eval" | "funded";
  haircut: number;       // the user's own counterparty discount, [0, 0.5]
  // The size the user is ALREADY trading, as a risk % of this firm's account.
  // null when the account has no R value - which is not a size of zero, it is a
  // size the app cannot see, and the two must never collapse into one number.
  curRisk: number | null;
}

export interface FirmPlan {
  n: number;
  tradesPerDay: number;      // MEASURED from the record, not the firm's tpd setting
  expectancy: number;
  // --- eval leg ---
  evalStage: "ok" | "instant" | "done" | "nopass";
  evalRisk: number; evalCost: number; evalDays: number; evalPass: number;
  evalBarMet: boolean; evalLo: number; evalHi: number; evalCheapest: number;
  // --- funded leg ---
  fundStage: "ok" | "peak-unsafe" | "none-safe" | "noedge";
  fundRisk: number; fundSurv: number; fundProfitPct: number; fundPays: number;
  peakLo: number; peakHi: number; peakSurv: number; peakProfitPct: number;
  // --- the payout funnel at the named funded size ---
  paid: number; paidDays: number;
  gated: boolean; paidUngated: number; paidUngatedDays: number;
  gates: GateRead[];
  evalCons: GateRead | null;     // the EVALUATION consistency cap, a different rule
  // --- the size the user is already trading, priced against the same rules.
  //     A DESCRIPTION of a choice already made, which is why it survives below
  //     PLAN_MIN_N where the recommendation does not. ---
  curRisk: number | null;
  curSurv: number; curProfitPct: number; curPays: number;
  curPaid: number; curPaidDays: number;
  // --- the provisional range, only between PLAN_BAND_MIN_N and PLAN_MIN_N ---
  sizeBand: Band | null;
}

// Walk the user's OWN trading days the way fundedSim walks simulated ones, and
// count how often a consistency rule would have blocked the withdrawal.
//
// This is the join the brief asks for, and it needs the RIGHT WINDOW to be
// honest. The journal already shows a "Best-day share" - best day over the whole
// record - but the firm's rule is best day over the profit since your LAST
// PAYOUT, a far shorter window, and a share measured over 80 trades is
// systematically smaller than one measured over the 12 that make up one payout.
// Comparing those two directly would flatter every trader who read it. So:
// accumulate day by day exactly as fundedSim does (negative days included, best
// day tracked, both reset on payout), close a window when accumulated profit
// reaches one payout's worth, and report how many of those windows a big day
// would have blocked.
export function consWindows(days: DayR[], needR: number, capPct: number): { windows: number; blocked: number; worst: number } {
  let profit = 0, best = 0, windows = 0, blocked = 0, worst = 0;
  if (!(needR > 0)) return { windows: 0, blocked: 0, worst: 0 };
  for (const d of days) {
    profit += d.r;
    if (d.r > best) best = d.r;
    if (profit >= needR) {
      windows++;
      const share = profit > 0 ? best / profit : 1;
      if (share > worst) worst = share;
      if (share > capPct / 100) blocked++;
      profit = 0; best = 0;
    }
  }
  return { windows, blocked, worst };
}

// ---------------------------------------------------------------------------
// buildPlan - chunked, cancellable, one macrotask per unit of work.
//
// COST. fundedCurve over the 25-point grid is the expensive call, and the
// journal's existing heavy work (scoreFirmsChunked) is chunked per macrotask
// precisely because a synchronous ~1s block is a visible hang on a Mac. Both
// curves seed PER RUN INDEX and not per risk index, so slicing the grid a point
// at a time is bit-identical to computing it whole - that property is what makes
// this chunkable at all, and it must not be "optimised" away.
// ---------------------------------------------------------------------------
export function buildPlan(
  input: PlanInput,
  onProgress: (done: number, total: number) => void,
  onDone: (plan: FirmPlan) => void,
): () => void {
  let cancelled = false;
  const { firm, rs, days, phase, curRisk } = input;
  const risks = riskGrid();
  const gateKeys = activeGates(firm);
  // an instant firm has no evaluation to size, and a funded account's is history
  const wantEval = !firm.instant && phase !== "funded";
  // the range replaces the point only in the window where a point is a guess
  const wantBand = rs.length >= PLAN_BAND_MIN_N && rs.length < PLAN_MIN_N;
  const wantCur = curRisk != null && curRisk > 0;

  const prof: number[] = [], surv: number[] = [], paysMed: number[] = [];
  const evalPts: EvalPoint[] = [];
  const bandSizes: number[] = [];
  let paid = 0, paidDays = 0, paidUngated = 0, paidUngatedDays = 0;
  let curSurv = 0, curProfitPct = 0, curPays = 0, curPaid = 0, curPaidDays = 0;
  const gateCost: Record<string, { dOdds: number; dDays: number }> = {};

  // Measured from the record rather than assumed: the winning-days and buffer
  // readings are about the user's real trade frequency, which is the whole
  // reason those two questions can be answered here and nowhere else.
  const tpdMeasured = days.length ? rs.length / days.length : Math.max(1, firm.tpd | 0);

  const queue: (() => void)[] = [];
  if (wantEval) {
    risks.forEach((r) => queue.push(() => {
      evalPts.push(withFirm(firm, () => withEdge(rs, () => challengeCurve([r], PLAN_EVAL_SIMS)[0])));
    }));
  }
  risks.forEach((r) => queue.push(() => {
    const c = withFirm(firm, () => withEdge(rs, () => fundedCurve([r], PLAN_FUND_SIMS, yearSteps())));
    prof.push(c.prof[0]); surv.push(c.surv[0]);
    const counts = c.pays[0].slice().sort((a, b) => a - b);
    paysMed.push(counts.length ? counts[(counts.length * 0.5) | 0] : 0);
  }));
  // The payout legs are measured AT the size the plan is about to name, so they
  // read `prof`/`surv` when they run rather than when they are queued.
  const sizedRisk = () => {
    const p = pickFundedSize(prof, surv);
    const i = p.inPlateau >= 0 ? p.inPlateau : p.anywhere >= 0 ? p.anywhere : p.flat.lo;
    return risks[i] ?? risks[0];
  };
  queue.push(() => {
    const po = withFirm(firm, () => withEdge(rs, () => payoutOdds(sizedRisk(), PAID_SIMS, yearSteps())));
    paid = po.p; paidDays = po.medDays;
  });
  if (gateKeys.length) {
    // The same 800 seeded price paths with every gate off. The difference is what
    // the gates cost, MEASURED rather than asserted - and its sign is provable
    // (see payoutOdds' own note): gates can only push the first qualifying moment
    // later, and ruin is absorbing, so later can only mean fewer accounts arrive.
    // Common random numbers are what make the comparison mean anything; without
    // per-run seeding the reshuffle swamps the effect, which is exactly how a
    // 20-day payout wait once measured 1.6pp BETTER than no wait at all.
    queue.push(() => {
      let bare: Firm = { ...firm };
      gateKeys.forEach((k) => { bare = withoutGate(bare, k); });
      const po = withFirm(bare, () => withEdge(rs, () => payoutOdds(sizedRisk(), PAID_SIMS, yearSteps())));
      paidUngated = po.p; paidUngatedDays = po.medDays;
    });
    // leave-one-out: which of them is actually doing the damage
    gateKeys.forEach((k) => queue.push(() => {
      const po = withFirm(withoutGate(firm, k), () => withEdge(rs, () => payoutOdds(sizedRisk(), PAID_SIMS, yearSteps())));
      gateCost[k] = { dOdds: paid - po.p, dDays: paidDays - po.medDays };
    }));
  }
  // The size the user is ALREADY trading, priced at that one point rather than
  // scanned for. Full quality and the same call the grid makes, so "at 0.50%"
  // here and 0.50% on the grid are the same number and not two estimates of it.
  if (wantCur) {
    queue.push(() => {
      const r = curRisk as number;
      const c = withFirm(firm, () => withEdge(rs, () => fundedCurve([r], PLAN_FUND_SIMS, yearSteps())));
      curProfitPct = c.prof[0]; curSurv = c.surv[0];
      const counts = c.pays[0].slice().sort((a, b) => a - b);
      curPays = counts.length ? counts[(counts.length * 0.5) | 0] : 0;
      const po = withFirm(firm, () => withEdge(rs, () => payoutOdds(r, PAID_SIMS, yearSteps())));
      curPaid = po.p; curPaidDays = po.medDays;
    });
  }
  // ...and the band, last, so a thin record still paints its tiles and its gates
  // while the range is still being drawn. One queue, one macrotask per draw -
  // this is appended to the chain above rather than started beside it (Trap #23).
  if (wantBand) {
    for (let d = 0; d < PLAN_BAND_DRAWS; d++) {
      queue.push(() => { bandSizes.push(bandDraw(firm, rs, 90210 + d)); });
    }
  }

  const total = queue.length;
  let i = 0;
  // ONE queue for the whole app (Trap #23). This used to be a private
  // setTimeout(step, 0) chain, which yields to the browser exactly as often as a
  // 3ms one and gives it nothing - and it ran beside runJob's queue rather than
  // in it, so a plan and a firm scan could interleave and each think it was the
  // only heavy thing on the page. The band draws below made that worse by 60
  // items, so it moves onto the real pump: runJob's 10ms slice is what decides
  // how many grid points fit in a tick, not this file.
  const step = () => {
    if (cancelled) return true;
    if (i >= total) return true;
    queue[i++]();
    onProgress(i, total);
    return i >= total;
  };

  function finish() {
    if (cancelled) return;
    const mu = withEdge(rs, () => expectancy());
    const pick = pickFundedSize(prof, surv);
    // A plateau tolerance is RELATIVE to the peak, so a no-edge curve of Monte
    // Carlo dust would still print a confident bracket - sizing advice ranking
    // noise. Under 1% of account per year at the BEST size there is nothing to
    // size. Same gate as the Funded tab's.
    const noEdge = mu <= 0 || (prof[pick.flat.pk] || 0) < 1;
    const idx = pick.inPlateau >= 0 ? pick.inPlateau : pick.anywhere >= 0 ? pick.anywhere : pick.flat.lo;
    const plan: FirmPlan = {
      n: rs.length, tradesPerDay: tpdMeasured, expectancy: mu,
      evalStage: firm.instant ? "instant" : phase === "funded" ? "done" : "ok",
      evalRisk: 0, evalCost: 0, evalDays: 0, evalPass: 0,
      evalBarMet: false, evalLo: 0, evalHi: 0, evalCheapest: 0,
      fundStage: noEdge ? "noedge" : pick.inPlateau >= 0 ? "ok" : pick.anywhere >= 0 ? "peak-unsafe" : "none-safe",
      fundRisk: risks[idx] ?? risks[0], fundSurv: surv[idx] ?? 0,
      fundProfitPct: prof[idx] ?? 0, fundPays: paysMed[idx] ?? 0,
      peakLo: risks[pick.flat.lo] ?? 0, peakHi: risks[pick.flat.hi] ?? 0,
      peakSurv: surv[pick.flat.lo] ?? 0, peakProfitPct: prof[pick.flat.pk] ?? 0,
      paid, paidDays, gated: gateKeys.length > 0, paidUngated, paidUngatedDays,
      gates: [], evalCons: null,
      curRisk: wantCur ? (curRisk as number) : null,
      curSurv, curProfitPct, curPays, curPaid, curPaidDays,
      sizeBand: wantBand && bandSizes.length ? bandOf(bandSizes, 0.9) : null,
    };
    if (wantEval && evalPts.length) {
      const ep = pickEvalSize(evalPts);
      const sel = evalPts[ep.pick], cheapest = evalPts[ep.pl.pk];
      // costToFund caps a hopeless edge at 200 attempts rather than dividing by
      // zero, so a firm nobody can pass produces a FLAT curve at the cap - and a
      // flat curve has a "cheapest" point like any other. Naming it would be a
      // sizing answer to a question that is not about sizing.
      if (mu <= 0 || cheapest.pass <= 0.005) plan.evalStage = "nopass";
      else {
        plan.evalRisk = sel.risk; plan.evalCost = sel.cost; plan.evalDays = sel.days;
        plan.evalPass = sel.pass; plan.evalBarMet = ep.barMet;
        plan.evalLo = evalPts[ep.pl.lo].risk; plan.evalHi = evalPts[ep.pl.hi].risk;
        plan.evalCheapest = cheapest.cost;
      }
    }
    plan.gates = readGates(input, plan, gateCost, days, tpdMeasured);
    plan.evalCons = readEvalCons(input, plan, days);
    onDone(plan);
  }

  const stop = runJob(step, () => { if (!cancelled) finish(); });
  return () => { cancelled = true; stop(); };
}

const money0 = (d: number) => "$" + Math.round(d).toLocaleString();

// What each of this firm's payout gates does to THIS plan, on THIS record.
//
// Every line is measured. The marginal cost comes from re-running the identical
// 800 seeded price paths with that one gate switched off; the frequency readings
// come from the user's own logged trading days rather than from an assumption.
// Nothing here invents a rule the firm's own fields do not carry.
function readGates(input: PlanInput, plan: FirmPlan, cost: Record<string, { dOdds: number; dDays: number }>, days: DayR[], tpd: number): GateRead[] {
  const f = input.firm;
  const out: GateRead[] = [];
  const r = plan.fundRisk;
  const acct = f.account > 0 ? f.account : 1;
  // the measured cost of a gate, as a SIGNED effect on the odds: a gate can only
  // lower them, so this is <= 0 up to Monte Carlo noise
  const eff = (...keys: string[]) => {
    const hit = keys.filter((k) => cost[k]);
    if (!hit.length) return { dOdds: null, dDays: null };
    let o = 0, d = 0;
    hit.forEach((k) => { o += cost[k].dOdds; d += cost[k].dDays; });
    return { dOdds: -o, dDays: -d };
  };
  const toneOf = (...keys: string[]) => {
    const e = eff(...keys);
    if (e.dOdds == null) return "" as const;
    return e.dOdds <= -0.15 ? "cell-stop" as const : e.dOdds <= -0.05 ? "cell-caution" as const : "cell-go" as const;
  };

  if ((f.payoutBuffer || 0) > 0) {
    const bufPct = ((f.payoutBuffer as number) / acct) * 100;
    // ...in R at the size this plan names, then in trading days of expected
    // drift. An ESTIMATE, and labelled one on screen: it is the mean path, and
    // half of real accounts take longer. The measured number is the pp beside it.
    const bufR = r > 0 ? bufPct / r : 0;
    const dd = plan.expectancy > 0 && tpd > 0 ? Math.round(bufR / plan.expectancy / tpd) : null;
    out.push({
      key: "buffer",
      rule: money0(f.payoutBuffer as number) + " of profit before any withdrawal",
      reading: dd == null
        ? "Your record does not drift up, so this buffer is not reached by trading."
        : "At " + r.toFixed(2) + "% risk that is " + bufR.toFixed(1) + "R &mdash; roughly <b>" + dd +
          " trading days</b> of drift at your +" + plan.expectancy.toFixed(2) +
          "R a trade, before the first dollar may leave. A mean path, not a date.",
      tone: toneOf("buffer"), ...eff("buffer"),
    });
  }
  if ((f.winDays || 0) > 0) {
    const need = f.winDays as number;
    const winPct = ((f.winAmt || 0) / acct) * 100;
    // THE JOIN. A day of the user's own record, sized at the plan's risk, either
    // clears this firm's bar or it does not. Nothing in the app measured this.
    const qual = days.filter((d) => d.r * r >= winPct - 1e-12).length;
    const share = days.length ? qual / days.length : 0;
    const per = share > 0 ? Math.ceil(need / share) : null;
    out.push({
      key: "windays",
      rule: need + " winning day" + (need === 1 ? "" : "s") +
        ((f.winAmt || 0) > 0 ? " of " + money0(f.winAmt as number) + "+" : "") + " before a payout",
      reading: !days.length
        ? "No dated trading days in this record to measure against."
        : "<b>" + qual + " of your " + days.length + "</b> logged trading days would have counted at " +
          r.toFixed(2) + "% risk (" + Math.round(share * 100) + "%)" +
          (per == null
            ? " &mdash; at that rate this rule never clears."
            : ", so " + need + " of them takes about <b>" + per + " trading days</b> per payout.") +
          (share >= 0.5 ? " It is not what is holding you up." : ""),
      tone: toneOf("windays"), ...eff("windays"),
    });
  }
  if ((f.payoutCons || 0) > 0) {
    const capPct = f.payoutCons as number;
    const needR = r > 0 ? firstPayoutPctOf(f) / r : 0;
    const w = consWindows(days, needR, capPct);
    out.push({
      key: "cons",
      rule: "no single day may be more than " + capPct + "% of the profit since your last payout",
      reading: w.windows === 0
        ? "Your record has not yet produced one payout's worth of profit at " + r.toFixed(2) +
          "% risk, so there is no window to measure this over."
        : "<b>" + w.blocked + " of " + w.windows + "</b> payout-sized windows in your own record would have been " +
          "blocked by it (biggest single day " + Math.round(w.worst * 100) + "% of its window&rsquo;s profit)" +
          (w.blocked === 0 ? " &mdash; your profit is spread widely enough that this rule does not bite." : "."),
      tone: w.windows === 0 ? "" : w.blocked > w.windows / 2 ? "cell-stop" : w.blocked > 0 ? "cell-caution" : "cell-go",
      ...eff("cons"),
    });
  }
  if ((f.payoutCapAmt || 0) > 0 || (f.payoutCap || 0) > 0) {
    const chunk$ = (PAY_CHUNK / 100) * acct;
    const capAmt = f.payoutCapAmt || 0, capPct = f.payoutCap || 0;
    const one$ = capAmt > 0 ? Math.min(chunk$, capAmt) : chunk$;
    const net$ = (one$ * f.split) / 100 * (1 - input.haircut);
    out.push({
      key: "cap",
      rule: [capAmt > 0 ? "at most " + money0(capAmt) + " per payout request" : "",
        capPct > 0 ? "at most " + capPct + "% of current profit per payout" : ""].filter(Boolean).join(", "),
      // "how many payouts a year the cap ladder actually allows" - from the sim's
      // own sweep COUNT at this size, which is the only number that knows about
      // the cap. Stated as a floor, because only the FIRST tier of a tiered
      // ladder is modelled and the catalogue note carries the rest.
      reading: "<b>" + plan.fundPays + " payout" + (plan.fundPays === 1 ? "" : "s") + " a year</b> at " +
        r.toFixed(2) + "% risk, typically " + money0(net$) + " each after your split" +
        (capAmt > 0
          ? " &mdash; and that is the FIRST tier only. A firm that raises the ceiling on later payouts pays more than this, so read it as a floor."
          : "."),
      tone: plan.fundPays >= 4 ? "cell-go" : plan.fundPays >= 1 ? "cell-caution" : "cell-stop",
      ...eff("cap%", "cap$"),
    });
  }
  if ((f.payoutFirst || 0) > 0 || (f.payoutMin || 0) > 0) {
    const bits: string[] = [];
    if ((f.payoutFirst || 0) > 0) bits.push("first payout only after " + f.payoutFirst + " trading days");
    if ((f.payoutMin || 0) > 0) bits.push("minimum withdrawal " + money0(f.payoutMin as number));
    out.push({
      key: "wait",
      rule: bits.join(", "),
      reading: "Your record reaches a first payout in about <b>" + plan.paidDays + " trading days</b>" +
        ((f.payoutFirst || 0) >= plan.paidDays && plan.paidDays > 0
          ? " &mdash; the firm&rsquo;s wait, not your trading, is what sets that date."
          : "."),
      tone: toneOf("first", "min"), ...eff("first", "min"),
    });
  }
  return out;
}

// The EVALUATION consistency cap is a different rule with the same shape, over a
// different window: the profit that reaches the target, not the profit since the
// last payout. `cons` carries the evaluation rule (firms.ts says so) and must
// never be reused as the payout gate - which is why this is measured separately
// rather than folded into readGates.
function readEvalCons(input: PlanInput, plan: FirmPlan, days: DayR[]): GateRead | null {
  const f = input.firm;
  if (!((f.cons || 0) > 0) || plan.evalStage !== "ok") return null;
  const r = plan.evalRisk;
  const targetR = r > 0 ? f.p1 / r : 0;
  const w = consWindows(days, targetR, f.cons);
  return {
    key: "evalcons",
    rule: "no single day may be more than " + f.cons + "% of the profit that passes the evaluation",
    reading: w.windows === 0
      ? "Your record has not yet produced one evaluation target&rsquo;s worth of profit at " + r.toFixed(2) +
        "% risk, so there is no window to measure this over."
      : "<b>" + w.blocked + " of " + w.windows + "</b> target-sized windows in your own record carried a day bigger than " +
        f.cons + "% of the run (biggest " + Math.round(w.worst * 100) + "%)" +
        (w.blocked === 0 ? " &mdash; this rule is unlikely to catch you." : "."),
    tone: w.windows === 0 ? "" : w.blocked > 0 ? "cell-caution" : "cell-go",
    dOdds: null, dDays: null,
  };
}
