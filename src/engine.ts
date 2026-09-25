// Monte Carlo engine (TS fallback; the Tauri build uses the identical Rust engine for the odds bootstrap)
import { mulberry, hasNum } from "./util";
import { S, F, Firm, withFirm } from "./state";
import { wilsonAt } from "./dd";

export function sampleR(rnd: () => number): number {
  if (S.trades && S.trades.length) return S.trades[(rnd() * S.trades.length) | 0];
  // ONE draw for all three outcomes, and with s=0 the comparison collapses to
  // the old u < p exactly - every anchor minted under the two-outcome model
  // survives bit-for-bit. Mirrored by Edge::Coin in engine.rs; the two must
  // keep identical operation ORDER or the desktop and browser builds drift.
  const u = rnd();
  if (u < S.s) return 0;
  return u < S.s + (1 - S.s) * S.p ? S.b : -1;
}
export function expectancy(): number {
  if (S.trades && S.trades.length) {
    let m = 0;
    for (const r of S.trades) m += r;
    return m / S.trades.length;
  }
  // per-trade expectancy across ALL trades: scratches dilute it toward zero
  return (1 - S.s) * (S.p * S.b - (1 - S.p));
}
export function sigmaR(): number {
  if (S.trades && S.trades.length) {
    const m = expectancy();
    let v = 0;
    for (const r of S.trades) v += (r - m) * (r - m);
    // SAMPLE standard deviation (n-1), matching statsDeep in the journal. With
    // the population form (n) the Simulator's Validate tab and the journal's
    // Stats tab printed DIFFERENT 95% ranges for the identical trades - narrower
    // by sqrt(1-1/n) - and at n=30 that was enough to return opposite verdicts on
    // the same record: "Statistically real" on one tab, "luck cannot be ruled
    // out" on the other. One estimator, one answer.
    //
    // The floor mirrors the slider branch below. Without it a record where every
    // trade returned the same R gives sd=0 and the tab printed a 95% interval of
    // literally zero width ("+0.25R to +0.25R") over a verdict of "Statistically
    // real" - certainty from 32 trades, which is the exact fabrication this app
    // refuses everywhere else.
    return Math.sqrt(Math.max(v / Math.max(1, S.trades.length - 1), 0.0001));
  }
  // three-outcome variance: b w.p. (1-s)p, -1 w.p. (1-s)(1-p), 0 w.p. s
  const w = (1 - S.s) * S.p, l = (1 - S.s) * (1 - S.p);
  const mu = w * S.b - l;
  return Math.sqrt(Math.max(w * S.b * S.b + l - mu * mu, 0.0001));
}
// Wilson score interval for a proportion. THE one win-rate CI in the app: the
// Simulator's Validate tab and the journal's Stats tab both call this, because
// when they each had their own the two screens printed different bands for the
// same trades. Wilson rather than Wald specifically because Wald degenerates at
// the edges - at p=1 it has zero width, which is how "the true win rate is
// between 100% and 100%" reached the screen from 20 winning trades. Wilson stays
// asymmetric and finite there (20/20 gives 84%-100%), which is the honest shape:
// a perfect record is evidence of a high rate, never of certainty.
// Delegated, not duplicated. The multiplicity adjustment on the Validate tab has
// to widen the win-rate interval too, which means Wilson at an arbitrary
// confidence - and the moment a second Wilson existed the two drifted, at the
// sixth decimal, because this one carried a rounded z = 1.96 while the other
// used the exact normal quantile. Sixth decimals do not reach a screen, but
// "there are two of these" is how the app previously ended up printing two
// different win-rate bands for the same trades. One implementation.
export function wilson(p: number, n: number): { lo: number; hi: number } {
  return wilsonAt(p, n, 0.95);
}
export function profitFactor(): number {
  if (S.trades && S.trades.length) {
    let gw = 0, gl = 0;
    for (const r of S.trades) { if (r > 0) gw += r; else gl -= r; }
    return gl > 0 ? gw / gl : 99;
  }
  return S.p <= 0 ? 0 : S.p < 1 ? (S.p / (1 - S.p)) * S.b : 99;
}

export interface WalkOut { res: "pass" | "ddfail" | "dailyfail" | "timeout"; path: number[] | null; trades: number; days: number }

// The drawdown floor, in R-scaled account percent. Three regimes:
//   static          - fixed distance below the starting balance; never moves
//   trailing        - trails the highest equity TICK (intraday). A spike you give
//                     back permanently raises the floor. The harshest rule.
//   trailing-eod    - trails only the highest end-of-day CLOSED balance, so
//                     intraday excursions are free. Much easier than intraday.
// ddLock clamps the trailing floor at break-even once it gets there, i.e. the
// threshold stops following you up past the starting balance.
// TRADES PER DAY IS A LOOP BOUND, AND IT HAD NO CEILING.
//
// Every walk in this engine steps `maxDays * tpd` times and every "year" is
// `252 * tpd` trades, so tpd multiplies the cost of literally every simulation.
// The firm editor accepted any number. Typing 10,000,000 into it asked phaseWalk
// for a five-billion-element path array - an immediate out-of-memory kill of the
// renderer - and asked fundedSim for 2.5 billion steps, which never returns.
// Worse, the firm is persisted, so the next launch reloaded the same value and
// died again: the app bricked itself and could only be recovered by clearing
// storage by hand. Reported from the field, reproduced exactly.
//
// Clamped HERE rather than only at the input, because the input is not the only
// way a firm arrives: saved presets, restored sim state, imported backups and
// account bindings all reach F without passing a form. 20 is above any plausible
// real setting (the app's own modelling assumption is 5) and keeps the worst
// case bounded. A clamp in one arithmetic helper cannot be forgotten by a new
// call site the way a `max` attribute can.
export const TPD_MAX = 20;
export function tpdOf(): number {
  return Math.max(1, Math.min(TPD_MAX, F.tpd | 0));
}
export function ddFloor(peak: number, peakEod: number, dd: number): number {
  if (F.ddType === "static") return -dd;
  const base = F.ddType === "trailing-eod" ? peakEod : peak;
  return F.ddLock ? Math.min(base - dd, 0) : base - dd;
}
// Evaluation day budget. 0 / absent means the firm imposes no time limit, in
// which case 500 days stands in for "as long as it takes" - long enough that the
// cap is not what decides the outcome.
export function evalDays(): number {
  const lim = F.timeLimit || 0;
  return lim > 0 ? Math.min(lim, 500) : 500;
}

export function phaseWalk(target: number, risk: number, rnd: () => number, record: boolean): WalkOut {
  let eq = 0, peak = 0, peakEod = 0, dayStart = 0;
  const tpd = tpdOf(), maxDays = evalDays();
  let dayIdx = 0, inDay = 0, reached = false;
  const dayPnls: number[] = [0];
  const coast = Math.min(risk, 0.12);
  const path: number[] | null = record ? [0] : null;
  for (let t = 0; t < maxDays * tpd; t++) {
    const useRisk = reached ? coast : risk;
    const step = sampleR(rnd) * useRisk;
    eq += step;
    dayPnls[dayIdx] += step;
    if (eq > peak) peak = eq;
    if (path) path.push(eq);
    const floor = ddFloor(peak, peakEod, F.maxdd);
    if (eq <= floor) return { res: "ddfail", path, trades: t + 1, days: dayIdx + 1 };
    if (F.daily > 0 && eq - dayStart <= -F.daily) return { res: "dailyfail", path, trades: t + 1, days: dayIdx + 1 };
    if (eq >= target) reached = true;
    if (eq >= target && dayIdx + 1 >= F.minDays) {
      const ok = F.cons <= 0 || (eq > 0 && Math.max(...dayPnls) / eq <= F.cons / 100);
      if (ok) return { res: "pass", path, trades: t + 1, days: dayIdx + 1 };
    }
    inDay++;
    // day rollover: the end-of-day balance is what an EOD trailing rule ratchets on
    if (inDay >= tpd) { inDay = 0; if (eq > peakEod) peakEod = eq; dayIdx++; dayStart = eq; dayPnls[dayIdx] = 0; }
  }
  // dayIdx already rolled past the last day when the final trade closed it, so
  // dayIdx + 1 reported maxDays + 1 - a duration the budget above forbids, which
  // then fed an inflated month count into costToFund. A timeout lasted exactly
  // the budget, by definition.
  return { res: "timeout", path, trades: maxDays * tpd, days: Math.min(maxDays, dayIdx + 1) };
}

export interface ChallengeOut {
  // `pass` is PHASE 1 ALONE and `dd`/`dl`/`to` are the ways phase 1 ends; `both`
  // is the end-to-end number and the only one that means "funded". Every caller
  // that wants "the firm's pass odds" must go through evalPass() below - reading
  // `pass` on a 2-step firm quotes the first gate as though it were the whole
  // evaluation, which is exactly what the Challenge tab used to paint.
  pass: number; both: number; dd: number; dl: number; to: number; medDays: number; daysArr: number[];
  // ---- the second phase, for a firm that has one ----
  // CONDITIONAL, and deliberately not a share of N like every field above it: of
  // the attempts that cleared phase 1, the share that went on to clear phase 2.
  // That is the question a trader sitting in phase 2 is actually asking, and it
  // is the number a single "clear both phases" figure hides - a 90% gate twice
  // over is 81% end to end, and the trader cannot see which gate is costing them
  // from the product alone. 0 when nothing reached phase 2, so a caller must
  // check `pass > 0` before printing it: "0%" and "nobody got there" are
  // different facts.
  pass2: number;
  // Phase-2 failures, as shares of ALL N attempts, so the seven terminal
  // outcomes (both, dd, dl, to, dd2, dl2, to2) sum to 1 and a stacked outcome
  // chart composes without renormalising.
  dd2: number; dl2: number; to2: number;
  // mean days burned per ATTEMPT across every outcome, wins and washouts alike.
  // A monthly-subscription firm charges for those days whether you pass or not,
  // so the fee model needs the all-outcomes mean, not the median of the winners.
  meanDaysAll: number;
  // mean days of the FAILED attempts alone - the bankroll planner's clock: a
  // budget of N attempts spends (N-1) failures' worth of calendar before the run
  // that finally passes, and failures are usually quicker than wins.
  meanFailDays: number;
}

export function challengeStats(risk: number, N: number): ChallengeOut {
  // ONE shared stream for the whole sweep, as it always was. Every number this
  // function returns is the EV on the Decision tab and the cost column in the
  // Firms table, so its draws must not move. challengeCurve below wants the
  // opposite property and gets its own seeding rather than changing this.
  const rnd = mulberry(12345);
  return challengeRun(risk, N, () => rnd);
}

// The body of challengeStats, with the source of randomness lifted out so a
// curve can seed per run and a level can keep one stream. `rndAt(i)` is called
// once per simulated attempt; returning the same closure every time reproduces
// the original shared-stream behaviour bit for bit.
function challengeRun(risk: number, N: number, rndAt: (i: number) => () => number): ChallengeOut {
  let pass = 0, both = 0, dd = 0, dl = 0, to = 0, sumDays = 0;
  // How the SECOND phase ends. Counting these consumes no draws - r2 has already
  // been walked, this only reads its result - so every seeded anchor in TS and
  // in engine.rs is untouched by their existence. That is the bar any addition
  // to this function has to clear.
  let dd2 = 0, dl2 = 0, to2 = 0;
  const daysArr: number[] = [];
  for (let i = 0; i < N; i++) {
    const rnd = rndAt(i);
    const r1 = phaseWalk(F.p1, risk, rnd, false);
    sumDays += r1.days;
    if (r1.res === "pass") {
      pass++;
      if (F.type === "2step" && F.p2 > 0) {
        const r2 = phaseWalk(F.p2, risk, rnd, false);
        sumDays += r2.days;
        if (r2.res === "pass") { both++; daysArr.push(r1.days + r2.days); }
        else if (r2.res === "ddfail") dd2++;
        else if (r2.res === "dailyfail") dl2++;
        else to2++;
      } else { both++; daysArr.push(r1.days); }
    } else if (r1.res === "ddfail") dd++;
    else if (r1.res === "dailyfail") dl++;
    else to++;
  }
  daysArr.sort((a, b) => a - b);
  let winSum = 0;
  for (const d of daysArr) winSum += d;
  const fails = N - both;
  return {
    pass: pass / N, both: both / N, dd: dd / N, dl: dl / N, to: to / N,
    // conditional on getting there; 0 when nobody did, and the caller gates on
    // `pass > 0` rather than this reading as a measured zero
    pass2: pass > 0 ? both / pass : 0,
    dd2: dd2 / N, dl2: dl2 / N, to2: to2 / N,
    medDays: daysArr.length ? daysArr[(daysArr.length * 0.5) | 0] : 0, daysArr,
    meanDaysAll: N ? sumDays / N : 0,
    meanFailDays: fails > 0 ? (sumDays - winSum) / fails : 0,
  };
}

// The firm's pass probability END TO END - the only figure that means "funded",
// and the mirror of what ChalOut.pass returns on the Rust side (engine.rs walks
// both phases and reports `both / n` under that name).
//
// This selector was written out at four call sites - renderChallenge, the eval
// curve, the journal odds panel, the Firms scorer - and the audit triage flagged
// it as one of only two genuine duplications left in the app. One implementation
// now, because the failure mode is silent: a copy that drops the `p2 > 0` guard,
// or one that never gets the `both` branch at all, quotes the first gate of a
// 2-step evaluation as the whole thing and reads optimistic with nothing on
// screen saying so.
export function evalPass(st: ChallengeOut, f: Firm = F): number {
  return f.type === "2step" && f.p2 > 0 ? st.both : st.pass;
}

// ---- THE EVAL-SIZE CURVE ----
//
// The funded side has had a size curve since 2.4.0; the evaluation side never
// did, and three screens filled the gap by telling the user to "lower the eval
// risk" without a number. On a firm with a time limit or a min-days rule that
// instruction is BACKWARDS: a smaller size passes less often inside the budget,
// so expected attempts climb, and on a monthly subscription each attempt also
// burns more billed calendar. Both effects push the cost of getting funded UP.
// Expected cost to fund is humped in size for exactly that reason - too big and
// the drawdown floor takes you, too small and the clock does - so there is an
// interior cheapest size, and it is a number the app can measure rather than
// guess at.
//
// The objective here is COST, not profit, and that is not an oversight: eval
// risk and funded risk are separate controls, and the eval size does not touch
// what a funded account earns. Getting funded for the least money is the whole
// job of this slider.
//
// Seeded per run, for the same reason fundedCurve is (see its note and the
// common-random-numbers rule): a run that washes out a day earlier at one size
// shifts every later run onto different draws, and the reshuffle is bigger than
// the effect being measured. challengeStats keeps its single stream because its
// numbers ARE the EV elsewhere.
export interface EvalPoint {
  risk: number;
  pass: number;      // end-to-end: every phase this firm actually runs
  cost: number;      // expected cash to reach a funded account, retries included
  attempts: number;
  days: number;      // expected trading days to funded: the failures, then the pass
}
const EVAL_CURVE_SEED = 12345;
export function challengeCurve(risks: number[], N: number): EvalPoint[] {
  return risks.map((risk) => {
    const st = challengeRun(risk, N, (i) => mulberry((EVAL_CURVE_SEED + i * 0x9e3779b1) | 0));
    const pass = evalPass(st);
    const cf = costToFund(pass, st.meanDaysAll);
    // the same clock the Decision tab's budget quantiles use: (n-1) washouts at
    // the failures' own mean, then the winners' median for the attempt that lands
    const days = Math.round((cf.attempts - 1) * st.meanFailDays + st.medDays);
    return { risk, pass, cost: cf.cost, attempts: cf.attempts, days };
  });
}

// How often the trader sweeps profit out, in trading days. 5 = weekly. This is a
// uniform modelling assumption applied to EVERY firm; it is deliberately NOT
// modified by the firm's own payout cadence. See the note on fundedSim.
export const SWEEP_HABIT_DAYS = 5;

// The size of one withdrawal, in R-scaled account percent. Both the cash-flow sim
// and the first-payout odds read it, so the two can never disagree about what a
// payout IS - 5% of the account, $2,500 on a $50k account.
export const PAY_CHUNK = 5;

// `profit` is CASH ACTUALLY WITHDRAWN, excluding whatever is left in the account
// at the end. That residue is collateral, not payout — on a locked trailing
// account you cannot take it without ending the account.
//
// WHY PAYOUT CADENCE IS NOT SCORED HERE. It was wired in and measured, and the
// result was backwards: slower payouts scored BETTER. The reason is structural.
// The only channel this model has for cadence is that unwithdrawn profit is
// exposed to the drawdown floor — but that same profit is also a cushion, and the
// cushion effect dominates. Withdrawing a fixed slice gave a humped curve (a
// 7-day window beat a 5-day one by 4%); sweeping the full excess instead made it
// monotonically increasing, right out to 30 days. What actually makes a slow
// payout bad — counterparty exposure, rule changes, accounts closed from under
// you, plain liquidity — is entirely outside the model, and inventing a hazard
// rate to stand in for it would be fabricating the answer.
//
// So `payoutEvery`, `payoutFirst` and `payoutMin` are carried on the firm and
// SHOWN, but they do not move the number HERE. A real cost left out is honest; a
// real cost scored with the wrong sign is not. They DO move firstPayoutSim below,
// where the sign can be proved rather than measured - read that note before
// concluding the two functions disagree.
// THE DAILY LOSS LIMIT IS ENFORCED HERE TOO (since 2.4.0). It always was in the
// evaluation walk, and its absence here was a v1 inheritance, not a decision:
// funded accounts at most firms carry the same daily limit (FTMO 5%, Topstep 2%),
// and the journal's rule guard already treats it as live on funded accounts.
// Leaving it out overstated funded survival and payout for 13 of the 20
// catalogue firms - Topstep's shown first-year payout was ~3.7x the enforced
// figure at 0.5% risk - and the overstatement was differential against the
// firms with no daily limit, so it skewed the ranking itself.
//
// Same modelling assumption as phaseWalk, on purpose: five fixed-size trades
// fire into the limit with no stop-for-day behaviour. That overstates the
// penalty for a disciplined trader, but eval and funded phases must price the
// same rule the same way; a behavioural day-stop refinement has to land on
// BOTH walks at once or the two phases start disagreeing about what a daily
// limit costs.
// PAYOUT GATES (2.8.0). payoutBuffer / payoutCap / winDays+winAmt are hard
// mechanics of when money may leave the account - "balance must reach $53k,
// then at most 50% of profit, after 5 winning days of $150+" is not a
// scheduling preference, it is arithmetic on every withdrawal - so they are
// modelled here, in the cash-flow itself. This is DIFFERENT from cadence
// (payoutEvery), which stays unpriced per the note below: cadence's only
// in-model effect had the wrong sign. The gates' in-model effects are the
// mechanics themselves; the counterparty cost of the profit they force you to
// leave at the firm remains outside the model, priced only by the USER's
// haircut slider. Expect a gated firm to show HIGHER survival - retained
// profit really is cushion - and read that beside your haircut, not instead
// of it.
//
// STREAM SAFETY, load-bearing: every gate is a branch on existing state and
// consumes NO draws, and with all four fields at 0 every comparison below
// reduces to the pre-gate code path exactly - all seeded anchors, TS and Rust,
// read the identical stream.
export function fundedSim(risk: number, T: number, rnd: () => number): { profit: number; alive: 0 | 1; pays: number } {
  let eq = 0, peak = 0, peakEod = 0, banked = 0, inDay = 0, sincePay = 0, dayStart = 0, pays = 0, winCount = 0;
  // consistency gate bookkeeping: the best single DAY and the profit earned,
  // both measured since the last payout (the app models the resetting variant,
  // which is what most firms publish - see the note on payoutCons)
  let bestDay = 0, profitSince = 0;
  const tpd = tpdOf();
  // an unlocked trailing threshold (of either flavour) follows the account up
  // forever, so a withdrawal drags the threshold down with it
  const trailUnlocked = F.ddType !== "static" && !F.ddLock;
  const chunk = PAY_CHUNK;
  const every = SWEEP_HABIT_DAYS;   // uniform across firms, on purpose
  // gates, converted to percent-of-account once
  const bufPct = F.account > 0 ? ((F.payoutBuffer || 0) / F.account) * 100 : 0;
  const capF = Math.max(0, Math.min(100, F.payoutCap || 0));
  const capAmtPct = F.account > 0 ? ((F.payoutCapAmt || 0) / F.account) * 100 : 0;
  const winN = Math.max(0, (F.winDays || 0) | 0);
  const winPct = F.account > 0 ? ((F.winAmt || 0) / F.account) * 100 : 0;
  const minPct = F.account > 0 ? ((F.payoutMin || 0) / F.account) * 100 : 0;
  const consF = Math.max(0, Math.min(100, F.payoutCons || 0));
  const gated = bufPct > 0 || capF > 0 || capAmtPct > 0 || winN > 0 || consF > 0;
  for (let i = 0; i < T; i++) {
    eq += sampleR(rnd) * risk;
    if (eq > peak) peak = eq;
    // checked BEFORE the rollover resets dayStart, mirroring phaseWalk, where
    // every check precedes the rollover - otherwise the last trade of each day
    // would escape the limit
    if (F.daily > 0 && eq - dayStart <= -F.daily) return { profit: banked, alive: 0, pays };
    inDay++;
    if (inDay >= tpd) {
      // a winning day is judged on the day's CLOSE, before dayStart resets
      const dayPnl = eq - dayStart;
      if (winN > 0 && dayPnl >= winPct) winCount++;
      // the consistency rule compares the BEST day against profit since the last
      // payout; both are measured on closed days, so they update together here
      if (consF > 0) { if (dayPnl > bestDay) bestDay = dayPnl; profitSince += dayPnl; }
      inDay = 0; sincePay++; if (eq > peakEod) peakEod = eq; dayStart = eq;
    }
    const fl = ddFloor(peak, peakEod, F.maxdd);
    if (eq <= fl) return { profit: banked, alive: 0, pays };
    // A big day does not fail the account - it BLOCKS withdrawals until later
    // profit dilutes its share below the threshold. That is a delay, which is
    // why this gate keeps the provable sign the first-payout leg relies on.
    const consOk = consF <= 0 || profitSince <= 0 || bestDay / profitSince <= consF / 100;
    if (sincePay >= every && consOk && (winN <= 0 || winCount >= winN) && (bufPct <= 0 || eq >= bufPct)) {
      // the withdrawal is the habit chunk, shrunk by the cap when one applies -
      // at most cap% of current profit may leave. A gated firm also refuses
      // anything under its minimum, so a cap-shrunk sliver is skipped rather
      // than paid; ungated firms keep the pre-gate behaviour exactly.
      // both caps bind together: the habit chunk, the %-of-profit cap, and the
      // firm's fixed dollar ceiling - whichever is smallest
      let w = chunk;
      if (capF > 0) w = Math.min(w, (capF / 100) * eq);
      if (capAmtPct > 0) w = Math.min(w, capAmtPct);
      const wOk = w > 0 && (!gated || w >= minPct);
      if (wOk && trailUnlocked) {
        // a withdrawal is not a trading loss: move dayStart down with it or the
        // sweep itself would trip the daily limit
        // every tracker shifts by the SAME chunk - clamping peakEod at zero made
        // the first sweep harsher on unlocked trailing-EOD rules (floor stayed
        // at -maxdd instead of following the withdrawal down), breaking this
        // branch's own invariant that a withdrawal is not a trading loss
        if (eq >= w) { banked += w; eq -= w; peak -= w; peakEod -= w; dayStart -= w; sincePay = 0; pays++; winCount = 0; bestDay = 0; profitSince = 0; }
      } else if (wOk && eq >= fl + F.maxdd + w) { banked += w; eq -= w; dayStart -= w; sincePay = 0; pays++; winCount = 0; bestDay = 0; profitSince = 0; }
    }
  }
  return { profit: banked, alive: 1, pays };
}
// `profit` is a MEAN, and the distribution behind it is heavily right-skewed: a
// minority of long-lived accounts carry it while the median account banks far
// less. paysMed/paysMean restate the same runs as a COUNT of withdrawals, which
// is what a funded trader actually experiences, and the median is the typical
// account rather than the average one.
//
// Counting consumes no draws and reorders nothing, so every seeded anchor in
// tests/unit/engine.test.mjs and src-tauri's cargo tests reads the identical
// stream it always did. That is deliberate and load-bearing: these numbers are
// also the Firms-table EV and the journal odds panel.
// bankedDeadMed / bankedAliveMed split the same runs by how they END: the
// median cash (percent of account) withdrawn by an account that BREACHES inside
// the horizon, and by one that survives it. The headline mean averages the two
// fates together, and at low survival that mean is carried by a minority of
// long-lived accounts - "profit $53k/yr" at 28% survival mostly describes
// accounts the user will not have. "If it dies, what did it pay me first?" is
// the number the likely outcome actually banks. Bookkeeping only: no extra
// draws, no reordering, every seeded anchor reads the identical stream.
export function fundedStats(risk: number, N: number, T: number): { profit: number; surv: number; paysMed: number; paysMean: number; bankedDeadMed: number; bankedAliveMed: number } {
  const rnd = mulberry(9931);
  let sp = 0, al = 0;
  const pays: number[] = [];
  const dead: number[] = [], alive: number[] = [];
  for (let i = 0; i < N; i++) {
    const r = fundedSim(risk, T, rnd);
    sp += r.profit; al += r.alive;
    // the sim counts its own sweeps now (gated firms withdraw variable
    // amounts, so profit/PAY_CHUNK stopped being a withdrawal count); with no
    // gates every sweep is exactly one chunk and this equals the old derivation
    pays.push(r.pays);
    (r.alive ? alive : dead).push(r.profit);
  }
  pays.sort((a, b) => a - b);
  dead.sort((a, b) => a - b);
  alive.sort((a, b) => a - b);
  let tot = 0;
  pays.forEach((c) => { tot += c; });
  return {
    profit: sp / N, surv: al / N,
    paysMed: N ? pays[(N * 0.5) | 0] : 0, paysMean: N ? tot / N : 0,
    bankedDeadMed: dead.length ? dead[(dead.length * 0.5) | 0] : 0,
    bankedAliveMed: alive.length ? alive[(alive.length * 0.5) | 0] : 0,
  };
}

// The Funded tab's profit-and-survival-versus-size curve.
//
// Same simulation as fundedStats, with one difference that matters more than the
// sim count: every risk level replays the IDENTICAL set of price paths, seeded
// per run. fundedStats draws all its runs from one shared stream, so a run that
// dies a step earlier at 0.94% shifts every later run onto different draws than
// the 0.82% column saw — the two columns are then not measuring the same market,
// and the difference between neighbouring sizes is mostly reshuffle. That is
// what put a 91% spike between two 84-87% neighbours and made the "best size"
// readout an argmax over noise.
//
// This cannot be fixed inside fundedStats: its numbers are the EV in the Firms
// table and the journal odds panel, and reseeding would move every one of them.
// A curve is a shape, so it gets its own estimator. Costs nothing extra — same
// runs, same horizon, only the seeding differs.
// `pays` is the RAW per-run withdrawal count at each size, not a summary. Keeping
// the samples means P(bank >= k withdrawals) can be answered at render time for
// ANY target k without re-simulating - so changing a payout goal is a redraw, not
// a 5,000-run recompute, and the curve cache stays valid across goal changes.
export function fundedCurve(risks: number[], N: number, T: number): { prof: number[]; surv: number[]; pays: number[][] } {
  const prof: number[] = [], surv: number[] = [], pays: number[][] = [];
  for (const risk of risks) {
    let sp = 0, al = 0;
    const counts: number[] = [];
    for (let i = 0; i < N; i++) {
      const r = fundedSim(risk, T, mulberry((9931 + i * 0x9e3779b1) | 0));
      sp += r.profit; al += r.alive;
      counts.push(r.pays);   // real sweep count - see fundedStats
    }
    prof.push(sp / N); surv.push(al / N); pays.push(counts);
  }
  return { prof, surv, pays };
}

// The flat top of that curve: the contiguous run of sizes paying within `tol` of
// the best one. A single argmax is not a usable answer here - the top is flat to
// within about a percent, so which point "wins" is settled by sampling noise. The
// same firm and edge put the peak at 0.94% on 240 runs, 1.06% on 1,400 and 0.82%
// on 6,000, while the profit at those three sizes differed by 1%. The plateau is
// stable where the argmax is not, and it is also the more useful answer: it says
// which sizes are genuinely interchangeable.
export function profitPlateau(prof: number[], tol: number): { pk: number; lo: number; hi: number } {
  let pk = 0;
  for (let i = 1; i < prof.length; i++) if (prof[i] > prof[pk]) pk = i;
  const cut = prof[pk] * (1 - tol);
  let lo = pk, hi = pk;
  while (lo > 0 && prof[lo - 1] >= cut) lo--;
  while (hi < prof.length - 1 && prof[hi + 1] >= cut) hi++;
  return { pk, lo, hi };
}

// The same doctrine pointed at a minimum: the contiguous run of sizes whose
// expected cost to fund is within `tol` of the cheapest. A cost curve is as flat
// at the bottom as a profit curve is at the top, and for the same reason - which
// exact point "wins" is settled by sampling noise - so the answer is a band.
//
// Delegated rather than duplicated, through the RECIPROCAL rather than a
// negation. Negating looks obvious and is wrong: profitPlateau's band is
// prof[pk] * (1 - tol), which on negative values asks for a cost strictly BELOW
// the cheapest one and so always returns a single point. 1/cost maps the minimum
// to a maximum and keeps the band multiplicative, which is what "within 3% of
// the cheapest" means: it admits cost <= cheapest / (1 - tol).
export function costPlateau(cost: number[], tol: number): { pk: number; lo: number; hi: number } {
  return profitPlateau(cost.map((c) => 1 / Math.max(1e-9, c)), tol);
}

// ---- PORTFOLIO: several accounts, ONE strategy ----
//
// The whole point, and the reason this cannot be N single-account runs stitched
// together: a trader running several accounts fires the SAME signals into all of
// them. The R sequence is not merely correlated, it is identical. What decides
// whether the outcomes differ is only that the RULES differ - a spike that
// ratchets an intraday-trailing floor may cost a static-floor account nothing.
//
// Two accounts at the same firm and the same size therefore pass together and
// die together: buying three evaluations does not triple the chance of getting
// funded, it triples the cost of one correlated bet. Independence would say
// 1-(1-p)^3; the truth is p. Both numbers are reported so the gap is visible.
//
// Mechanics: every account replays the identical uniform stream, because each
// sim seeds by index and sampleR consumes exactly one draw per trade in both its
// branches. Account j at wall-clock step t therefore sees the same market as
// account k at step t, whichever phase either happens to be in - the streams
// stay in lockstep by construction rather than by bookkeeping.
const PORT_SEED = 5150;
const portSeed = (i: number) => (PORT_SEED + i * 0x9e3779b1) | 0;

export interface Slot { firm: Firm; risk: number }

export interface PortEvalOut {
  n: number;              // accounts in the book
  marg: number[];         // each account's own pass rate
  all: number;            // every account funded
  any: number;            // at least one funded
  indepAny: number;       // what independence WOULD have predicted, same run
  dist: number[];         // P(exactly k of n funded), k = 0..n
  cost: number;           // one attempt each, fees + activations
}

export function portfolioEval(slots: Slot[], N: number): PortEvalOut {
  const k = slots.length;
  const passed: Uint8Array[] = slots.map(() => new Uint8Array(N));
  const marg = new Array(k).fill(0);
  let cost = 0;
  slots.forEach((sl, a) => {
    withFirm(sl.firm, () => {
      cost += F.fee + (F.activation || 0);
      const twoStep = F.type === "2step" && F.p2 > 0;
      for (let i = 0; i < N; i++) {
        // SAME seed for every account: identical market, different rules
        const rnd = mulberry(portSeed(i));
        if (F.instant) { passed[a][i] = 1; marg[a]++; continue; }
        const r1 = phaseWalk(F.p1, sl.risk, rnd, false);
        if (r1.res !== "pass") continue;
        if (twoStep && phaseWalk(F.p2, sl.risk, rnd, false).res !== "pass") continue;
        passed[a][i] = 1; marg[a]++;
      }
    });
  });
  const dist = new Array(k + 1).fill(0);
  let all = 0, any = 0;
  for (let i = 0; i < N; i++) {
    let c = 0;
    for (let a = 0; a < k; a++) c += passed[a][i];
    dist[c]++;
    if (c === k) all++;
    if (c > 0) any++;
  }
  // the independence baseline comes from THIS run's own marginals, so the
  // comparison is exact rather than two models talking past each other
  let indepNone = 1;
  for (let a = 0; a < k; a++) indepNone *= 1 - marg[a] / N;
  return {
    n: k, marg: marg.map((m) => m / N), all: all / N, any: any / N,
    indepAny: 1 - indepNone, dist: dist.map((d) => d / N), cost,
  };
}

export interface PortFundedOut {
  n: number;
  survMarg: number[];     // each account alive at the horizon
  survAll: number; survAny: number;
  indepAny: number;
  dist: number[];         // P(exactly k alive)
  payout: number;         // expected total dollars withdrawn, after each split
  nothing: number;        // P(the whole book pays zero)
  paidAny: number;        // at least one account reaches a first withdrawal
}

export function portfolioFunded(slots: Slot[], N: number, T: number): PortFundedOut {
  const k = slots.length;
  const alive: Uint8Array[] = slots.map(() => new Uint8Array(N));
  const bank: Float64Array[] = slots.map(() => new Float64Array(N));
  const survMarg = new Array(k).fill(0);
  slots.forEach((sl, a) => {
    withFirm(sl.firm, () => {
      const acct = F.account, split = F.split;
      for (let i = 0; i < N; i++) {
        const r = fundedSim(sl.risk, T, mulberry(portSeed(i)));
        alive[a][i] = r.alive;
        survMarg[a] += r.alive;
        // percent-of-account R units to this account's own dollars, then split
        bank[a][i] = ((r.profit / 100) * acct * split) / 100;
      }
    });
  });
  const dist = new Array(k + 1).fill(0);
  let survAll = 0, survAny = 0, paidAny = 0, nothing = 0, sumPay = 0;
  for (let i = 0; i < N; i++) {
    let c = 0, tot = 0;
    for (let a = 0; a < k; a++) { c += alive[a][i]; tot += bank[a][i]; }
    dist[c]++;
    if (c === k) survAll++;
    if (c > 0) survAny++;
    if (tot > 0) paidAny++; else nothing++;
    sumPay += tot;
  }
  let indepNone = 1;
  for (let a = 0; a < k; a++) indepNone *= 1 - survMarg[a] / N;
  return {
    n: k, survMarg: survMarg.map((m) => m / N), survAll: survAll / N, survAny: survAny / N,
    indepAny: 1 - indepNone, dist: dist.map((d) => d / N),
    payout: sumPay / N, nothing: nothing / N, paidAny: paidAny / N,
  };
}

// ---- FIRST PAYOUT: does any money come out at all? ----
//
// fundedSim answers "how much cash over a year". This answers the blunter
// question underneath it: does the account ever pay you ONCE before it dies?
// A firm can look fine on expected dollars and still be a coin flip on whether
// you personally ever see one, because expectation averages over the funded
// accounts that ran hot, and you only get one.
//
// THE FIRM'S PAYOUT GATE IS SCORED HERE, unlike in fundedSim. That is not an
// inconsistency, it is the entire reason this is a separate function. Cadence had
// to stay out of the EV because its sign there is wrong (see the long note on
// fundedSim). For the FIRST payout the sign is not measured but provable: until
// that first withdrawal the equity path is identical whatever the gates say -
// nothing has been taken out yet - so a longer wait or a higher minimum can only
// move the first qualifying moment LATER, and ruin is absorbing, so a later
// moment can only mean more chances to die before reaching it. Every gate is
// monotone non-increasing in this probability. engine.rs locks that with a test,
// the mirror image of the one that locks cadence out of the EV.
//
// Only the FIRST-payout gate applies: payoutFirst (days you must wait) and
// payoutMin (the smallest withdrawal). payoutEvery is a minimum SPACING between
// payouts, and there is no previous payout to space against, so it is inert here
// and is not consulted - the ongoing cadence remains shown, never scored.
//
// Not modelled: funded-side consistency caps, which several firms apply to
// withdrawals at a different rate than to the evaluation. The catalogue's `cons`
// carries the evaluation rule only, so applying it here would be scoring a number
// that was measured for something else.
// How big the first withdrawal is, in percent of account: the trader's own sweep
// chunk, or the firm's minimum when that is larger. One definition, read both by
// the sim that decides whether the account ever gets there and by the dollar
// value the UI puts on arriving - if those two drifted apart the table would be
// pricing a payout the simulation never made.
export function firstPayoutPct(): number {
  // payoutMin is dollars; everything in the engine is percent of account
  const minPct = F.account > 0 ? ((F.payoutMin || 0) / F.account) * 100 : 0;
  return Math.max(PAY_CHUNK, minPct);
}

export function firstPayoutSim(risk: number, T: number, rnd: () => number): { paid: 0 | 1; days: number } {
  let eq = 0, peak = 0, peakEod = 0, inDay = 0, day = 0, dayStart = 0, winCount = 0;
  let bestDay = 0, profitSince = 0;
  const tpd = tpdOf();
  const trailUnlocked = F.ddType !== "static" && !F.ddLock;
  // you cannot withdraw before the firm opens the window, and you would not
  // withdraw sooner than your own habit even if it let you
  const firstDay = Math.max(F.payoutFirst || 0, SWEEP_HABIT_DAYS);
  const need = firstPayoutPct();
  // the payout gates - see fundedSim. For a FIRST payout their sign is provable
  // (the note on payoutOdds): a buffer, a cap or a winning-days rule can only
  // push the first qualifying moment later, and ruin is absorbing, so gates can
  // only lower these odds - which is why this leg has always been allowed to
  // price gate fields while cadence stays out of the EV. All 0 = pre-gate path.
  const bufPct = F.account > 0 ? ((F.payoutBuffer || 0) / F.account) * 100 : 0;
  const capF = Math.max(0, Math.min(100, F.payoutCap || 0));
  const capAmtPct = F.account > 0 ? ((F.payoutCapAmt || 0) / F.account) * 100 : 0;
  const minPct = F.account > 0 ? ((F.payoutMin || 0) / F.account) * 100 : 0;
  const winN = Math.max(0, (F.winDays || 0) | 0);
  const winPct = F.account > 0 ? ((F.winAmt || 0) / F.account) * 100 : 0;
  const consF = Math.max(0, Math.min(100, F.payoutCons || 0));
  for (let i = 0; i < T; i++) {
    eq += sampleR(rnd) * risk;
    if (eq > peak) peak = eq;
    // daily loss limit, same placement and reasoning as fundedSim above
    if (F.daily > 0 && eq - dayStart <= -F.daily) return { paid: 0, days: day };
    inDay++;
    if (inDay >= tpd) {
      const dayPnl = eq - dayStart;
      if (winN > 0 && dayPnl >= winPct) winCount++;
      if (consF > 0) { if (dayPnl > bestDay) bestDay = dayPnl; profitSince += dayPnl; }
      inDay = 0; day++; if (eq > peakEod) peakEod = eq; dayStart = eq;
    }
    const fl = ddFloor(peak, peakEod, F.maxdd);
    if (eq <= fl) return { paid: 0, days: day };
    // qualification: window open, winning days served, buffer reached, and the
    // cap-shrunk withdrawable share still covers a whole first payout
    // A % cap DELAYS the first payout (you need profit >= need/cap before the
    // allowed slice covers a withdrawal). A FIXED dollar cap does not delay it -
    // it only limits the size - EXCEPT when the ceiling sits below the firm's
    // own minimum withdrawal, which makes a payout arithmetically impossible.
    const gatesOk = (winN <= 0 || winCount >= winN) && (bufPct <= 0 || eq >= bufPct) &&
      (capF <= 0 || (capF / 100) * eq >= need) &&
      (capAmtPct <= 0 || capAmtPct >= minPct) &&
      // a consistency rule delays like the rest: a big day blocks the request
      // until further profit dilutes its share below the threshold
      (consF <= 0 || profitSince <= 0 || bestDay / profitSince <= consF / 100);
    if (day >= firstDay && gatesOk && (trailUnlocked ? eq >= need : eq >= fl + F.maxdd + need)) return { paid: 1, days: day };
  }
  return { paid: 0, days: day };
}

// One sim count for every screen that quotes this number, so the same firm cannot
// read 62% in the journal and 60% in the Firms table. Cheap - most runs resolve
// inside a few weeks rather than running the full horizon.
export const PAID_SIMS = 800;

// p = share of funded accounts that reach a first withdrawal inside T steps.
// medDays = trading days from funding to that withdrawal, for the ones that got there.
//
// COMMON RANDOM NUMBERS: every run gets its own seeded stream instead of drawing
// from one shared one. The other stats in this file share a stream, which is fine
// for them but would wreck this: a run that ends a step earlier or later shifts
// every LATER run onto different draws, so tightening a gate reshuffles the whole
// sample and the effect being measured drowns in the reshuffle. Measured that way
// a 20-day wait scored 1.6pp BETTER than no wait at all - pure noise, and exactly
// the shape of result that got payout cadence thrown out of the EV. Seeding per
// run means two gate settings see the identical 800 price paths, so the
// difference between them is the gate and nothing else. It also steadies the
// ranking, where neighbouring firms are often a point or two apart.
export function payoutOdds(risk: number, N: number, T: number): { p: number; medDays: number; d10: number; d90: number; chunkPct: number } {
  let paid = 0;
  const days: number[] = [];
  for (let i = 0; i < N; i++) {
    const r = firstPayoutSim(risk, T, mulberry((7717 + i * 0x9e3779b1) | 0));
    if (r.paid) { paid++; days.push(r.days); }
  }
  days.sort((a, b) => a - b);
  // d10/d90 are deciles of the CONDITIONAL distribution - the runs that paid.
  // The spread matters more than the middle for cashflow planning: median 40d
  // with a 131d tail is a different proposition from median 45d with a 70d one.
  // Whole days only; 800 runs make deciles stable, not exact.
  return {
    p: N ? paid / N : 0,
    medDays: days.length ? days[(days.length * 0.5) | 0] : 0,
    d10: days.length ? days[(days.length * 0.1) | 0] : 0,
    d90: days.length ? days[(days.length * 0.9) | 0] : 0,
    chunkPct: firstPayoutPct(),
  };
}
// Expected dollars spent getting to a funded account.
//
// A one-time fee is paid once per attempt, so the expectation is fee / pPass.
// A MONTHLY subscription is charged for every month the evaluation runs -
// washouts included - so the per-attempt cost is the monthly rate times the
// months an average attempt burns. It uses the all-outcomes mean rather than the
// median of the winners on purpose: fast passes are not what makes a
// subscription expensive, slow failures are. The activation fee lands once, on
// the attempt that finally succeeds.
export const TRADING_DAYS_PER_MONTH = 21;

// One year of trading, in trades, at the app's assumed 5 trades/day. EVERY figure
// that calls itself "per year" or "first-year" must use this — the journal's
// suggested-firm card once ran 500 while the Firms table ran 750 and both said
// "1st-yr payout", so the same firm showed $75,884 in one place and $116,977 in
// the other. Cheap/FAST passes may cut the number of SIMULATIONS; they must never
// cut the horizon, or the answer changes meaning rather than precision.
// A YEAR, in trades. It has to be derived from trades-per-day rather than fixed,
// for two reasons that were both live bugs:
//
//  1. 750 trades at the documented 5/day is 150 trading days - 7.1 months by
//     this file's own TRADING_DAYS_PER_MONTH, eight lines up. Every "per year",
//     "first-year" and "~1yr" figure in the app was a seven-month figure,
//     understating annual payout by about 38% while the fee it was netted
//     against was billed on the 21-day month.
//  2. A fixed TRADE count means the elapsed time of "a year" moved with the
//     user's own trades-per-day setting: 750 trades spans 750 trading days at
//     1/day and 75 at 10/day. Profit came out bit-identical across that 10x
//     range, which is absurd on its face - trading ten times as often for the
//     same calendar year cannot pay the same - and every firm rule measured in
//     DAYS (payoutEvery, payoutFirst, minDays, timeLimit) was being compared
//     against a clock that stretched underneath it.
//
// Fixing the horizon to a fixed number of DAYS settles both: a year is 252
// trading days for every firm and every setting, and trading more often inside
// it produces more, which is what actually happens.
export const TRADING_DAYS_PER_YEAR = TRADING_DAYS_PER_MONTH * 12;
export function yearSteps(): number {
  return TRADING_DAYS_PER_YEAR * tpdOf();
}
export function costToFund(pPass: number, meanDaysAll: number): { cost: number; months: number; attempts: number } {
  // a hopeless edge would divide by ~0; cap it so the verdict reads
  // "not worth it" rather than Infinity
  const attempts = pPass > 0.005 ? 1 / pPass : 200;
  if (F.feeMode === "monthly") {
    // A subscription runs CONTINUOUSLY across attempts. The old form billed
    // ceil(days/21) months PER ATTEMPT, so three quick washouts inside one
    // calendar month were charged as three full months - for a fast-failing
    // edge that overbilled ~3x against this function's own contract ("charged
    // for every month the evaluation runs") and skewed the ranking against
    // monthly firms. `months` is now the months the subscription runs in total,
    // expected attempts included. Firms that demand a PAID reset per attempt
    // inside a billing month are slightly under-billed by this; that error is
    // bounded by the reset price, where the old error was unbounded in attempts.
    const months = Math.max(1, Math.ceil((attempts * meanDaysAll) / TRADING_DAYS_PER_MONTH));
    return { cost: F.fee * months + (F.activation || 0), months, attempts };
  }
  const months = 1;
  // Discounted resets: many one-time-fee firms sell a re-attempt cheaper than a
  // fresh purchase. First attempt at full price, every re-attempt at the reset
  // price. Absent/zero resetFee = every attempt at full fee, bit-for-bit the
  // old behaviour. (Monthly firms never reach here - their subscription renewal
  // already IS the reset, priced continuously above.)
  if ((F.resetFee || 0) > 0 && attempts > 1) {
    return { cost: F.fee + (attempts - 1) * (F.resetFee as number) + (F.activation || 0), months, attempts };
  }
  return { cost: F.fee * attempts + (F.activation || 0), months, attempts };
}

// maxDD() USED TO LIVE HERE AND HAS BEEN DELETED ON PURPOSE. It walked exactly
// `n` trades - the length of the record - so the Validate tab's "Plan for DD"
// silently forecast a horizon equal to however many trades the user happened to
// have logged, and it walked them from the POINT ESTIMATE, one line under an
// interval saying the point estimate might be ten points of win rate out. Both
// defects were in the signature, not the body, which is why it is gone rather
// than fixed: any caller passing (n, N) is asking the wrong question.
// `ddSim` in dd.ts is the replacement - it takes explicit horizons, returns a
// percentile ladder at each, and resamples the record before simulating forward.

// ---- trade R computation (shared by journal + editor) ----
export interface TradeLike {
  R?: number | string | null; Rmanual?: boolean;
  riskAmt?: number | string | null; pnl?: number | string | null;
  entry?: number | string | null; stop?: number | string | null;
  target?: number | string | null; exit?: number | string | null;
  rrR?: number | string | null;
  direction?: string;
}

export function computeRraw(t: TradeLike): number {
  if (hasNum(t.riskAmt) && Number(t.riskAmt) > 0 && hasNum(t.pnl)) return Number(t.pnl) / Number(t.riskAmt);
  if (hasNum(t.entry) && hasNum(t.stop) && hasNum(t.exit)) {
    const e = Number(t.entry), s = Number(t.stop), x = Number(t.exit), per = Math.abs(e - s);
    if (per > 0) { const dir = t.direction === "short" ? -1 : 1; return ((x - e) / per) * dir; }
  }
  if (hasNum(t.pnl)) return Number(t.pnl) > 0 ? 1 : Number(t.pnl) < 0 ? -1 : 0;
  return 0;
}
// Does this trade have a real basis for an R multiple, or would computeRraw fall
// through to the ±1 sign guess? That last branch is fine for colouring a row, but
// it must never feed the edge statistics: a $500 win and a $20 loss both become
// ±1R, which collapses Kelly's payoff ratio to exactly 1.0 and lets the prop-odds
// Monte Carlo resample fabricated payoffs. Broker CSVs hit this on every row,
// since they carry no stop and no per-trade risk.
// An R past this is not a measurement: it is a typo (an extra zero in Risk $),
// or a stop a hair's width from the entry. One such row used to turn the
// Performance ranges into -Infinity..+Infinity, print $NaN, and freeze the
// simulator outright. It is excluded from the R statistics exactly like a
// trade with no stop, and counted as such on screen.
export const R_MAX = 1000;
export function hasRBasis(t: TradeLike): boolean {
  if (!hasRBasisRaw(t)) return false;
  const r = computeR(t);
  return isFinite(r) && Math.abs(r) <= R_MAX;
}
function hasRBasisRaw(t: TradeLike): boolean {
  if (hasNum(t.R) && (t.Rmanual || t.Rmanual === undefined)) return true;
  if (hasNum(t.riskAmt) && Number(t.riskAmt) > 0 && hasNum(t.pnl)) return true;
  if (hasNum(t.entry) && hasNum(t.stop) && hasNum(t.exit)) {
    return Math.abs(Number(t.entry) - Number(t.stop)) > 0;
  }
  return false;
}
// manual override wins; legacy imports without the Rmanual flag keep their stored R;
// auto trades are always re-derived from fields (self-heals earlier bad saves)
export function computeR(t: TradeLike): number {
  if (hasNum(t.R) && (t.Rmanual || t.Rmanual === undefined)) return Number(t.R);
  return computeRraw(t);
}
// The planned reward:risk. Two ways in, one way out, same shape as excursions():
// a typed R is a STATEMENT and wins; prices are a derivation and come second.
// Requiring the prices is what locked an R-first journal out of the target sweep
// entirely - it reported "nothing to sweep" on a record of 30+ trades, because
// not one of them had ever named a price and none ever needs to.
export function plannedRR(t: TradeLike): number | null {
  if (hasNum(t.rrR)) {
    const v = Number(t.rrR);
    if (isFinite(v) && v > 0) return v;
  }
  if (hasNum(t.entry) && hasNum(t.stop) && hasNum(t.target)) {
    const e = Number(t.entry), s = Number(t.stop), g = Number(t.target), per = Math.abs(e - s);
    if (per > 0) { const dir = t.direction === "short" ? -1 : 1; return ((g - e) / per) * dir; }
  }
  return null;
}
