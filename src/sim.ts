// Simulator: edge bar, firm bar, five tabs, theme, persistence, mode switch.
import { $, $i, $s, $c, css, fit, mulberry, LS, hooks, ask, toast, esc, chartTip, pctEst, mixHex, runJob } from "./util";
import { S, F, PRESETS, setFirm, clampFirm, withEdge, view, money, amt, ddLabel, gateLabel } from "./state";
import { portfolioSim } from "./engine";
import { sampleR, expectancy, sigmaR, profitFactor, phaseWalk, challengeStats, challengeCurve, evalPass, evalDays, fundedStats, fundedCurve, profitPlateau, costToFund, payoutOdds, firstPayoutPct, PAID_SIMS, PAY_CHUNK, SWEEP_HABIT_DAYS, TRADING_DAYS_PER_MONTH, TRADING_DAYS_PER_YEAR, yearSteps, tpdOf, TPD_MAX, WalkOut, ChallengeOut, EvalPoint } from "./engine";
// The forward-drawdown engine and the uncertainty machinery the Validate tab
// needs: horizon-aware bootstraps, effective sample size, the multiplicity
// widening and the risk-per-trade solver. See the header of dd.ts.
import { ddJob, effectiveN, fitBlock, overshootProfile, maxRiskForLimit, zFor, wilsonAt, DDMethod, DDResult, DDPoint } from "./dd";
// The sizing RULES live in plan.ts, not here, and this tab calls them. They used
// to be spelled out inline in renderFunded and evalAdvice, which is fine while
// one screen asks the question - but the journal's "My firm" surface asks the
// same question about a BOUND firm, and two copies of a rule is how this app
// previously ended up quoting one firm two different numbers on two tabs. One
// implementation, both callers. See the header of plan.ts.
import { sharesAt, optSettings, setOpt, resetOpt, isDefault, OPT_DEFAULTS, netCurve, pickBalancedAt, pickVelocity, pickMaxNet, ladderSizes, pickPerCount, recommendCount, PortfolioStat } from "./optimize";
import { riskGrid, pickFundedSize, pickEvalSize, PLATEAU_TOL, SAFE_SURV, PASS_BAR, PLAN_MIN_N, Band, bandOf, bandText, resampleRecord, plausibleRecord, pickBalanced, ROBUST_CONF, ROBUST_DRAWS, ROBUST_SIMS, ROBUST_EVAL_SIMS } from "./plan";

// the panel ids are "p-" + tab; kept in one place so adding a tab cannot
// half-register it (the list used to be spelled out twice)
const TABS = ["validate", "challenge", "funded", "decision"];
let TAB = "validate";
let MODE = "sim";
let PATH_SEED = 777;
// which phase the paths chart is drawing. Deliberately NOT persisted and not part
// of any cache key: it is a way of looking at one panel, not an input to a
// simulation - nothing else on the tab reads it, and every number stays end to
// end whichever phase is on screen.
let CPHASE = 1;

// two-tier rendering: while a control is being dragged, run cheap sims (FAST);
// 250ms after the last input, re-render once at full quality. rAF coalesces bursts.
let FAST = false;
let rafPending = false;
let fullT: ReturnType<typeof setTimeout> | null = null;
export function scheduleRender() {
  FAST = true;
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; render(); });
  }
  if (fullT) clearTimeout(fullT);
  fullT = setTimeout(() => { FAST = false; render(); }, 250);
}

const swr = () => $i("swr"), spay = () => $i("spay"), sn = () => $i("sn");

// mirror a value into a number input unless the user is typing in it right now
export function setNum(id: string, v: string) {
  const el = $i(id);
  if (document.activeElement !== el) el.value = v;
}

export function syncSliders() {
  S.p = Number(swr().value) / 100;
  S.s = Math.max(0, Math.min(0.9, Number($i("ssc").value) / 100));
  S.n = Number(sn().value);
  if (S.payMode === "pf") {
    const pf = Number(spay().value);
    S.b = S.p > 0.001 && S.p < 0.999 ? (pf * (1 - S.p)) / S.p : 1;
    S.b = Math.max(0.05, S.b);
  } else {
    S.b = Number(spay().value);
  }
  setNum("nwr", swr().value);
  setNum("npay", spay().value);
  setNum("nn", sn().value);
  setNum("nsc", $i("ssc").value);
}
export function sumStrat() {
  const pf = profitFactor(), ev = expectancy();
  $("sbSum").innerHTML =
    (S.trades ? "<b>" + S.trades.length + "</b> journal trades" : "sliders") +
    " &middot; win " + Math.round(S.p * 100) + "%" +
    (S.trades || S.s <= 0 ? "" : " &middot; " + Math.round(S.s * 100) + "% scratch") +
    " &middot; PF " + (pf >= 99 ? "high" : pf.toFixed(2)) +
    " &middot; exp " + (ev >= 0 ? "+" : "") + ev.toFixed(2) + "R";
}
export function enableSliders(on: boolean) {
  ["swr", "spay", "sn", "nwr", "npay", "nn", "ssc", "nsc"].forEach((id) => { $i(id).disabled = !on; });
  $("edgeBar").classList.toggle("jlocked", !on);
}
// number input <-> slider pairing: typing routes through the slider's own input event
function wireNum(numId: string, rangeId: string) {
  const numEl = $i(numId), rangeEl = () => $i(rangeId);
  numEl.addEventListener("input", function () {
    if (this.value === "" || !isFinite(Number(this.value))) return;
    rangeEl().value = this.value;
    rangeEl().dispatchEvent(new Event("input", { bubbles: true }));
  });
  numEl.addEventListener("change", function () { this.value = rangeEl().value; }); // clamp to slider range on blur
}

const fFields = ["fAccount", "fType", "fInstant", "fP1", "fP2", "fMaxdd", "fDdType", "fDdLock", "fDaily", "fMinDays", "fCons", "fTpd", "fSplit", "fFee", "fTimeLimit", "fFeeMode", "fActivation", "fResetFee", "fPayEvery", "fPayFirst", "fPayMin", "fPayBuffer", "fPayCap", "fPayCapAmt", "fPayCons", "fWinDays", "fWinAmt"];

// user-saved firm presets (localStorage; selected via "c:<name>" values in the preset dropdown)
let CUSTOM: Record<string, import("./state").Firm> = LS.get("pel_presets", {});
function rebuildPresetSel() {
  const sel = $s("fPreset"), cur = sel.value;
  sel.innerHTML = "";
  const ogB = document.createElement("optgroup");
  ogB.label = "Built-in";
  Object.keys(PRESETS).forEach((k) => {
    const o = document.createElement("option");
    o.value = k; o.textContent = PRESETS[k].name || k;
    ogB.appendChild(o);
  });
  sel.appendChild(ogB);
  const names = Object.keys(CUSTOM).sort();
  if (names.length) {
    const ogC = document.createElement("optgroup");
    ogC.label = "My presets";
    names.forEach((n) => {
      const o = document.createElement("option");
      o.value = "c:" + n; o.textContent = n;
      ogC.appendChild(o);
    });
    sel.appendChild(ogC);
  }
  // the "(custom)" park position: the state the dropdown sits in whenever the
  // loaded rules match no preset, so it can stop asserting a firm that is not
  // in force. Last, not first - the named entries are the ones people pick.
  const oc = document.createElement("option");
  oc.value = ""; oc.textContent = "(custom — as edited)";
  oc.title = "The rules in force match no saved preset. Pick a preset to load one, or Save as preset to name these rules.";
  sel.appendChild(oc);
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
  $("fDelPreset").classList.toggle("hide", !sel.value.startsWith("c:"));
}

// The dropdown NAMES the rules in force, so it has to FOLLOW them. It used to
// keep whatever was last picked - through Firms row-clicks, field edits, preset
// deletes and reloads - which left it asserting a firm that was not loaded; and
// because its handler fires on `change`, re-picking the name it already showed
// was a no-op, so the one preset you could not load was the one on the label.
// Matching by VALUE rather than by remembering intent self-heals across all of
// those paths, and parking on "(custom)" when nothing matches means clicking
// any named preset is always a real change event. Account size is deliberately
// excluded: presets carry rules, the account field owns the size.
function firmRulesKey(f: Partial<import("./state").Firm>): string {
  return [f.type, f.p1, f.p2, f.maxdd, f.ddType, Number(f.ddLock) || 0, f.daily || 0, f.minDays || 0,
    f.cons || 0, f.tpd, f.split, f.fee, f.timeLimit || 0, f.feeMode || "once", f.activation || 0,
    f.resetFee || 0, f.payoutEvery || 0, f.payoutFirst || 0, f.payoutMin || 0, f.instant ? 1 : 0,
    f.payoutBuffer || 0, f.payoutCap || 0, f.payoutCapAmt || 0, f.payoutCons || 0, f.winDays || 0, f.winAmt || 0].join("|");
}
function syncPresetSel() {
  const sel = document.getElementById("fPreset") as HTMLSelectElement | null;
  if (!sel || !sel.options.length) return;
  const key = firmRulesKey(F);
  const ruleOf = (v: string) => (v.startsWith("c:") ? CUSTOM[v.slice(2)] : PRESETS[v]);
  // STABILITY FIRST: if the option currently named still matches the loaded
  // rules, keep it. Several presets can carry identical rules - a custom saved
  // straight off a built-in is the common case - and both labels are then
  // true; hopping to the other one right after "Save as preset" reads as the
  // save having failed.
  const cur = sel.value;
  const curP = cur ? ruleOf(cur) : null;
  let match = curP && firmRulesKey(curP) === key ? cur : "";
  if (!match) for (const k of Object.keys(PRESETS)) if (firmRulesKey(PRESETS[k]) === key) { match = k; break; }
  if (!match) for (const n of Object.keys(CUSTOM)) if (firmRulesKey(CUSTOM[n]) === key) { match = "c:" + n; break; }
  sel.value = match;
  $("fDelPreset").classList.toggle("hide", !match.startsWith("c:"));
}

export function firmToForm() {
  document.querySelectorAll<HTMLButtonElement>("#accChips .opt").forEach((b) =>
    b.setAttribute("aria-pressed", Number(b.getAttribute("data-acc")) === F.account ? "true" : "false"));
  $i("fAccount").value = String(F.account); $s("fType").value = F.type;
  $s("fInstant").value = F.instant ? "1" : "0";
  $i("fP1").value = String(F.p1); $i("fP2").value = String(F.p2); $i("fMaxdd").value = String(F.maxdd);
  $s("fDdType").value = F.ddType; $s("fDdLock").value = String(F.ddLock);
  $i("fDaily").value = String(F.daily); $i("fMinDays").value = String(F.minDays); $i("fCons").value = String(F.cons);
  $i("fTpd").value = String(F.tpd); $i("fSplit").value = String(F.split); $i("fFee").value = String(F.fee);
  $i("fTimeLimit").value = String(F.timeLimit || 0);
  $s("fFeeMode").value = F.feeMode || "once";
  $i("fActivation").value = String(F.activation || 0);
  $i("fResetFee").value = String(F.resetFee || 0);
  $i("fPayEvery").value = String(F.payoutEvery || 0);
  $i("fPayFirst").value = String(F.payoutFirst || 0);
  $i("fPayMin").value = String(F.payoutMin || 0);
  $i("fPayBuffer").value = String(F.payoutBuffer || 0);
  $i("fPayCap").value = String(F.payoutCap || 0);
  $i("fPayCapAmt").value = String(F.payoutCapAmt || 0);
  $i("fPayCons").value = String(F.payoutCons || 0);
  $i("fWinDays").value = String(F.winDays || 0);
  $i("fWinAmt").value = String(F.winAmt || 0);
  syncP2();
}
// phase-2 target only applies to 2-step firms: keep the cell in the grid
// (so rows stay paired, no hole) but disable and dim it for other types.
// Same treatment for the trailing-lock question, which is meaningless on a
// static floor, and for the fee label, which flips to a monthly rate.
function syncP2() {
  // an instant firm has no evaluation, so BOTH targets are inert, not just P2
  const inst = !!F.instant;
  const off = inst || F.type !== "2step";
  $i("fP1").disabled = inst;
  $("wrapP1").style.opacity = inst ? "0.4" : "";
  $i("fP2").disabled = off;
  $("wrapP2").style.opacity = off ? "0.4" : "";
  const noTrail = F.ddType === "static";
  $s("fDdLock").disabled = noTrail;
  $("wrapDdLock").style.opacity = noTrail ? "0.4" : "";
  $("fFeeLbl").textContent = F.feeMode === "monthly" ? "Fee per month ($)" : "Challenge fee ($)";
}
// `Number(raw) || default` treated an emptied field and a typed 0 alike as
// "use the preset default", so deleting the account size to retype it snapped
// the firm to $100,000 on the very keystroke that emptied the box - the $50k
// was gone before the user typed a digit - and a typed 0 in Max drawdown
// became 10% instead of the documented 0.5% floor. An empty box keeps the
// CURRENT value (the user is mid-edit; blur rewrites the field from F); a real
// number goes to the clamp like any other.
function numOr(raw: string, cur: number): number {
  const v = Number(raw);
  return raw.trim() === "" || !isFinite(v) ? cur : v;
}
function formToFirm() {
  F.account = Math.max(1000, numOr($i("fAccount").value, F.account));
  F.type = $s("fType").value as typeof F.type;
  // instant used to be the one rule the form could neither see nor change: it
  // arrived only by loading a catalogue firm, survived every field edit (this
  // function rewrote 21 fields and skipped it), and silently kept pricing a
  // 100% pass leg after the user had rebuilt the firm into a 2-step challenge.
  // A rule that flips the whole evaluation model has to be on the form.
  F.instant = $s("fInstant").value === "1";
  F.p1 = Math.max(0.1, numOr($i("fP1").value, F.p1));
  F.p2 = Math.max(0, numOr($i("fP2").value, F.p2));
  F.maxdd = Math.max(0.5, numOr($i("fMaxdd").value, F.maxdd));
  F.ddType = $s("fDdType").value as typeof F.ddType;
  F.ddLock = Number($s("fDdLock").value);
  F.daily = Math.max(0, numOr($i("fDaily").value, F.daily));
  F.minDays = Math.max(0, numOr($i("fMinDays").value, F.minDays));
  F.cons = Math.max(0, numOr($i("fCons").value, F.cons));
  F.tpd = Math.max(1, numOr($i("fTpd").value, F.tpd));
  F.split = Math.min(100, Math.max(0, numOr($i("fSplit").value, F.split)));
  F.fee = Math.max(0, numOr($i("fFee").value, F.fee));
  F.timeLimit = Math.max(0, numOr($i("fTimeLimit").value, F.timeLimit || 0));
  F.feeMode = $s("fFeeMode").value as typeof F.feeMode;
  F.activation = Math.max(0, numOr($i("fActivation").value, F.activation || 0));
  F.resetFee = Math.max(0, numOr($i("fResetFee").value, F.resetFee || 0));
  F.payoutEvery = Math.max(0, numOr($i("fPayEvery").value, F.payoutEvery || 0));
  F.payoutFirst = Math.max(0, numOr($i("fPayFirst").value, F.payoutFirst || 0));
  F.payoutMin = Math.max(0, numOr($i("fPayMin").value, F.payoutMin || 0));
  F.payoutBuffer = Math.max(0, numOr($i("fPayBuffer").value, F.payoutBuffer || 0));
  F.payoutCap = Math.min(100, Math.max(0, numOr($i("fPayCap").value, F.payoutCap || 0)));
  F.payoutCapAmt = Math.max(0, numOr($i("fPayCapAmt").value, F.payoutCapAmt || 0));
  F.payoutCons = Math.min(100, Math.max(0, numOr($i("fPayCons").value, F.payoutCons || 0)));
  F.winDays = Math.max(0, numOr($i("fWinDays").value, F.winDays || 0));
  F.winAmt = Math.max(0, numOr($i("fWinAmt").value, F.winAmt || 0));
  // THE FORM IS A ROUTE INTO F LIKE ANY OTHER, and this one writes field by field
  // rather than through setFirm, so it was the one route the domain table did not
  // cover. Typing 10,000,000 into Trades per day left F.tpd at ten million: the
  // engine clamped on READ so nothing hung, but the value was still what got
  // SAVED, so it sat in localStorage waiting to be loaded by a build without the
  // read-clamp. Clamp here too and the poison never gets written down.
  //
  // The `change` handler calls firmToForm() straight after this, so the input
  // snaps to the clamped value on commit; the `input` handler deliberately does
  // not, because rewriting a box mid-keystroke fights the person typing in it.
  clampFirm(F);
  syncP2();
}
// prop-firm mode on/off: body class drives the CSS; the tab in force has to be
// one that exists in the mode
export function applyPropMode() {
  document.body.classList.toggle("noprop", !view.PROP);
  $i("propMode").checked = view.PROP;
  $("firmTitle").textContent = view.PROP ? "The firm" : "Your account";
  $("firmToggle").textContent = view.PROP ? "Edit rules" : "Edit";
  if (!view.PROP && TAB !== "validate") {
    TAB = "validate";
    document.querySelectorAll<HTMLButtonElement>(".tabs button[data-tab]").forEach((x) =>
      x.setAttribute("aria-pressed", x.getAttribute("data-tab") === TAB ? "true" : "false"));
    TABS.forEach((t) => $("p-" + t).classList.toggle("hide", t !== TAB));
  }
  sumFirm();
}
export function sumFirm() {
  if (!view.PROP) {
    $("firmSum").innerHTML = money(F.account) + " account &middot; max drawdown " + F.maxdd + "% (" +
      money((F.maxdd / 100) * F.account) + ") &middot; " + F.tpd + " trade" + (F.tpd === 1 ? "" : "s") + " a day";
    syncPresetSel();
    return;
  }
  // an instant firm has no target to hit - saying so HERE matters because this
  // line is the one place the loaded firm is summarised on every tab, and
  // instant flips the entire evaluation model (Decision prices the fee as a
  // certain purchase, not a gamble on passing)
  const t = F.instant ? "<b>instant funding</b> (no evaluation)"
    : F.type === "2step" ? "targets " + amt(F.p1) + " then " + amt(F.p2) : "target " + amt(F.p1);
  const feeTxt = F.feeMode === "monthly" ? money(F.fee) + "/mo" : money(F.fee);
  $("firmSum").innerHTML =
    money(F.account) + " &middot; " + t + " &middot; " + ddLabel(F) +
    " DD " + amt(F.maxdd) + (F.daily > 0 ? " &middot; daily " + amt(F.daily) : "") +
    (F.timeLimit && F.timeLimit > 0 ? " &middot; " + F.timeLimit + "d limit" : " &middot; no time limit") +
    " &middot; fee " + feeTxt +
    // the loaded firm's payout gates shape every tab's numbers - the one-line
    // summary is the one place the firm in force is always visible
    (gateLabel(F) ? " &middot; " + gateLabel(F) : "");
  // every path that changes the firm ends here, so this is where the preset
  // dropdown is made to agree with the rules actually in force
  syncPresetSel();
}

function color(x: number): string {
  return x >= 0.85 ? css("--go") : x >= 0.55 ? css("--caution") : css("--stop");
}
function riskSub(riskPct: number): string {
  return riskPct.toFixed(2) + "% of account = " + money((riskPct / 100) * F.account) + " per trade";
}

// ---------------- VALIDATE ----------------
//
// This tab's whole job is telling the user how confident to be. It was doing
// that well for three of its four numbers and badly for the fourth: "Plan for
// DD: ~5R typical, ~8R rough" was a median with no horizon, computed at the
// point estimate, one line under an interval saying the point estimate might be
// ten points of win rate out. See the header of dd.ts for the full charge sheet.
//
// The rule that now governs the whole screen: EVERY headline statistic with an
// interval must propagate that interval into anything derived from it, and no
// drawdown figure may appear without both a horizon and a percentile.

// The population being resampled. A journal edge hands over its real trades; a
// slider edge has no trades at all, so one is constructed to the three outcomes
// the sliders describe - which is exactly what sampleR draws from, made explicit
// so the same bootstrap code can run over both.
function ddPopulation(): number[] {
  if (S.trades && S.trades.length) return S.trades;
  const N = 1000;
  const scr = Math.round(N * S.s), win = Math.round((N - scr) * S.p);
  const out: number[] = [];
  for (let i = 0; i < scr; i++) out.push(0);
  for (let i = 0; i < win; i++) out.push(S.b);
  while (out.length < N) out.push(-1);
  return out;
}
// The same record in the order it was traded, when the journal knows it. Serial
// structure is only measurable in time order, and S.trades deliberately is not
// in it (see the note on EdgeMeta).
function ddSeries(): number[] {
  return S.meta && S.meta.ordered ? S.meta.ordered : ddPopulation();
}
// Only a real, ordered journal record can carry serial structure. A slider edge
// is iid by construction; block-bootstrapping it would invent clustering that
// is not merely unmeasured but known to be absent.
function serialMeasurable(): boolean {
  return !!(S.meta && S.meta.ordered && S.meta.ordered.length >= 20);
}

// How many distinct subsets of this record have been tested. The Leave-out
// control is a multiple-comparisons engine and the nominal 95% stops meaning 95%
// after the second look, so every interval on this screen is Bonferroni-widened
// by the number of looks and the banner says how many.
function edgeLooks(): number {
  return S.meta ? Math.max(1, S.meta.looks) : 1;
}
function edgeConf(): number {
  return 1 - 0.05 / edgeLooks();
}

// n, and how many INDEPENDENT observations it really is.
function edgeN(): { n: number; nEff: number; note: string; basis: string } {
  const n = S.trades && S.trades.length ? S.trades.length : S.n;
  if (!serialMeasurable()) {
    return { n, nEff: n, basis: "none", note: S.trades ? "too short to measure dependence" : "slider edge — independent by construction" };
  }
  const e = effectiveN(S.meta!.ordered!, S.meta!.days);
  const bits: string[] = [];
  if (e.basis === "cluster") bits.push("trades cluster by day (" + e.meanCluster.toFixed(1) + " a day)");
  else if (e.basis === "serial") bits.push("runs of similar trades (lag-1 " + e.rho1.toFixed(2) + ")");
  if (S.meta!.accounts > 1) bits.push(S.meta!.accounts + " accounts pooled");
  if (S.meta!.mirrored > 0) bits.push(S.meta!.mirrored + " look like the same signal in two accounts");
  return { n, nEff: Math.round(e.nEff), basis: e.basis, note: bits.join(" · ") || "no measurable dependence" };
}

// ---- the drawdown job: cached, deferred, both methods in one pass ----
interface DDJob { key: string; block: DDResult; iid: DDResult; fit: ReturnType<typeof fitBlock>; over: ReturnType<typeof overshootProfile> }
let ddCache: DDJob | null = null;
let ddPending: string | null = null;
let ddCancel: (() => void) | null = null;
// 400 x 15 = 6,000 futures. Split one-outer-draw-per-step it is ~0.3ms a step.
const DD_OUTER = 400, DD_INNER = 15;

// The horizon, and its default. localStorage is the source of truth rather than
// the input box, because the box does not exist yet when the journal loads and
// the default has to be derived from the record rather than picked: a year of
// the user's OWN trading, at their own pace, is the horizon they actually plan
// over. 250 only stands in when there is no record to ask.
function ddHorizon(): number {
  const stored = LS.get<number>("pel_dd_horizon", 0);
  if (stored >= 50) return Math.min(2000, Math.max(50, Math.round(stored / 50) * 50));
  const m = S.meta;
  if (m && m.days && m.ordered && m.days.length) {
    const perDay = m.ordered.length / new Set(m.days).size;
    const yr = Math.round((perDay * TRADING_DAYS_PER_YEAR) / 50) * 50;
    if (yr >= 50) return Math.min(2000, yr);
  }
  return 250;
}
function ddOpts(): { method: DDMethod; overshoot: boolean } {
  return {
    method: serialMeasurable() && LS.get<string>("pel_dd_method", "block") === "block" ? "block" : "iid",
    overshoot: LS.get<boolean>("pel_dd_overshoot", true),
  };
}
function ddCheckpoints(h: number): number[] {
  const base = [50, 100, 250, 500, 1000, 2000].filter((c) => c <= 2000);
  if (base.indexOf(h) < 0) base.push(h);
  return base.sort((a, b) => a - b);
}
function ddFingerprint(pop: number[]): string {
  let sum = 0, sq = 0;
  for (const r of pop) { sum += r; sq += r * r; }
  return pop.length + "_" + sum.toFixed(3) + "_" + sq.toFixed(3);
}
// Kicked off the paint, never run inline: 12M walk steps is a visible hang on a
// Mac and this tab re-renders on every slider drag (Traps #11 and #15).
function ensureDD(): DDJob | null {
  const series = ddSeries(), h = ddHorizon(), o = ddOpts();
  const fitted = serialMeasurable() ? fitBlock(series) : { rho1: 0, block: 1, se: 0, significant: false };
  const key = ddFingerprint(series) + "|" + h + "|" + o.overshoot + "|" + fitted.block;
  if (ddCache && ddCache.key === key) return ddCache;
  if (ddPending === key) return null;
  ddPending = key;
  const cps = ddCheckpoints(h);
  // Both methods every time, because the panel SHOWS the gap between them: a
  // block result quoted on its own is a number the reader cannot calibrate.
  //
  // Through the shared job queue in SLICES, not one setTimeout doing the lot.
  // This is ~24 million walk steps to a 2,000-trade horizon; run whole it froze
  // the window for a third of a second at a time, which - stacked with the band
  // job and the plan builder - is what made the app unclickable. One outer draw
  // per step is ~0.3ms, so the pump fits dozens into a slice and still yields.
  const common = { block: fitted.block, overshoot: o.overshoot };
  const jb = ddJob(series, cps, { method: "block", ...common }, DD_OUTER, DD_INNER);
  const ji = ddJob(series, cps, { method: "iid", ...common }, DD_OUTER, DD_INNER);
  let leg = 0;
  if (ddCancel) ddCancel();
  ddCancel = runJob(
    () => { if (leg === 0) { if (jb.step()) leg = 1; return false; } return ji.step(); },
    () => {
      ddCancel = null;
      if (ddPending !== key) return;
      ddCache = { key, block: jb.result(), iid: ji.result(), fit: fitted, over: overshootProfile(series) };
      ddPending = null;
      if (TAB === "validate" && MODE === "sim") renderValidate();
    });
  return null;
}

// The expectancy sampling distribution, with zero marked.
//
// This replaced a win-rate bell whose caption promised a dashed break-even line
// that could not render: with ~1.74R winners break-even is a 36% win rate, and
// the plotted range was the CI around 56%, so the line was always off the left
// edge. It also drew a band from p +/- 1.96se while the row beside it printed
// the Wilson bounds, so the picture and the text disagreed by a point at each
// end. Both defects come from plotting a quantity the verdict is not about. The
// verdict is `expectancy interval stays above zero`; this draws exactly that,
// zero is always in frame because the axis is built to include it, and the
// shaded band IS the interval printed beside it - one number, one picture.
// the last arguments each Validate chart was drawn with, so the report can
// redraw the same chart at its own size (redrawValidateCharts)
let lastBell: [number, number, number, number, number] | null = null;
let lastDD: [DDJob, number, DDMethod] | null = null;
export function redrawValidateCharts() {
  if (lastBell) drawBell(...lastBell);
  if (lastDD) drawDDCurve(...lastDD);
}
function drawBell(mu: number, se: number, lo: number, hi: number, conf: number) {
  lastBell = [mu, se, lo, hi, conf];
  const g = fit($c("cBell")), ctx = g.ctx, W = g.w, H = g.h, pL = 10, pR = 10, pT = 14, pB = 26;
  ctx.clearRect(0, 0, W, H);
  if (!(se > 0)) return;
  // always include zero AND the whole interval, with a margin either side
  const span = Math.max(Math.abs(hi), Math.abs(lo), Math.abs(mu)) + 3.2 * se;
  const xLo = Math.min(-0.15 * span, lo - 1.4 * se), xHi = Math.max(0.15 * span, hi + 1.4 * se);
  const X = (v: number) => pL + ((v - xLo) / (xHi - xLo)) * (W - pL - pR);
  const pdf = (v: number) => Math.exp(-((v - mu) * (v - mu)) / (2 * se * se));
  const base = H - pB, ampl = H - pT - pB;
  // the shaded region is the interval the row beside it prints - not a
  // recomputed one, the same lo/hi passed in
  ctx.beginPath(); ctx.moveTo(X(lo), base);
  for (let v = lo; v <= hi; v += (hi - lo) / 90) ctx.lineTo(X(v), base - ampl * pdf(v));
  ctx.lineTo(X(hi), base); ctx.closePath();
  ctx.fillStyle = lo > 0 ? css("--band-go") : css("--band-mid"); ctx.fill();
  // the interval's edges, dashed in the band's own colour so they line up with
  // the printed bounds below and read apart from the red break-even line
  ctx.strokeStyle = lo > 0 ? css("--go") : css("--caution"); ctx.lineWidth = 1.4; ctx.setLineDash([4, 4]);
  [lo, hi].forEach((v) => { ctx.beginPath(); ctx.moveTo(X(v), pT + 12); ctx.lineTo(X(v), base); ctx.stroke(); });
  ctx.setLineDash([]);
  ctx.strokeStyle = css("--ink"); ctx.lineWidth = 2.2; ctx.beginPath();
  for (let v = xLo; v <= xHi; v += (xHi - xLo) / 140) {
    const x = X(v), y = base - ampl * pdf(v);
    if (v === xLo) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // zero: the line the verdict actually turns on, and it can never be off-screen
  ctx.strokeStyle = css("--stop"); ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(X(0), pT - 4); ctx.lineTo(X(0), base); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = css("--stop-ink"); ctx.font = "700 10px " + css("--sans"); ctx.textAlign = "center";
  ctx.fillText("break even", X(0), pT + 6);
  ctx.fillStyle = css("--muted"); ctx.font = "10px " + css("--mono");
  [lo, mu, hi].forEach((v) => ctx.fillText((v >= 0 ? "+" : "") + v.toFixed(2) + "R", X(v), base + 15));
  // right-aligned: break-even sits wherever zero falls, which on a positive edge
  // is near the left, and a left-aligned caption printed straight through it
  ctx.textAlign = "right";
  ctx.fillText(Math.round(conf * 1000) / 10 + "% interval", W - pR - 2, pT + 6);
  ctx.textAlign = "left";
}

// Drawdown against horizon. The single most important thing this chart does is
// make it obvious that the number moves - a trader who reads "8R" once and
// budgets for it forever is the reader this whole panel is for.
function drawDDCurve(job: DDJob, h: number, method: DDMethod) {
  lastDD = [job, h, method];
  const cv = $c("cDD"), g = fit(cv), ctx = g.ctx, W = g.w, H = g.h, pL = 40, pR = 12, pT = 14, pB = 30;
  ctx.clearRect(0, 0, W, H);
  const pts = (method === "block" ? job.block : job.iid).points;
  if (!pts.length) return;
  const xs = pts.map((p) => p.horizon);
  const xLo = Math.log(xs[0]), xHi = Math.log(xs[xs.length - 1]);
  const yMax = Math.max(1, pts[pts.length - 1].p99 * 1.12);
  const X = (t: number) => pL + ((Math.log(t) - xLo) / Math.max(1e-9, xHi - xLo)) * (W - pL - pR);
  const Y = (v: number) => pT + (1 - Math.min(v, yMax) / yMax) * (H - pT - pB);
  // Gridlines FIRST, under the data. A drawdown chart with no y scale is a mood,
  // not a measure, and this one is read to decide position size.
  const stepR = yMax > 40 ? 10 : yMax > 20 ? 5 : yMax > 8 ? 2 : 1;
  ctx.strokeStyle = css("--line"); ctx.lineWidth = 1;
  for (let v = stepR; v <= yMax; v += stepR) {
    const y = Y(v);
    ctx.beginPath(); ctx.moveTo(pL, y); ctx.lineTo(W - pR, y); ctx.stroke();
  }
  // p50 -> p99 as a filled envelope, so the SPREAD is the message rather than
  // any one line: the gap between the coin flip and the tail is the whole point
  const band = (a: (p: DDPoint) => number, b: (p: DDPoint) => number, fill: string) => {
    ctx.beginPath();
    pts.forEach((p, i) => { const x = X(p.horizon), y = Y(a(p)); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(X(pts[i].horizon), Y(b(pts[i])));
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  };
  band((p) => p.p90, (p) => p.p99, css("--band-stop"));
  band((p) => p.p50, (p) => p.p90, css("--band-mid"));
  const line = (f: (p: DDPoint) => number, col: string, w: number, dash: number[]) => {
    ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash(dash); ctx.beginPath();
    pts.forEach((p, i) => { const x = X(p.horizon), y = Y(f(p)); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.stroke(); ctx.setLineDash([]);
  };
  line((p) => p.p99, css("--stop"), 1.8, [4, 3]);
  line((p) => p.p90, css("--ink"), 2.4, []);
  line((p) => p.p50, css("--muted"), 1.6, [3, 3]);
  // where the user is planning to
  const hx = X(Math.max(xs[0], Math.min(xs[xs.length - 1], h)));
  ctx.strokeStyle = css("--go"); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(hx, pT); ctx.lineTo(hx, H - pB); ctx.stroke();
  ctx.font = "10px " + css("--mono");
  ctx.textAlign = "right"; ctx.fillStyle = css("--muted");
  for (let v = 0; v <= yMax; v += stepR) ctx.fillText(v + "R", pL - 5, Y(v) + 3);
  ctx.textAlign = "center";
  ctx.fillStyle = css("--muted");
  xs.forEach((t) => { if (t === 50 || t === 100 || t === 250 || t === 500 || t === 1000 || t === 2000) ctx.fillText(String(t), X(t), H - pB + 14); });
  ctx.fillText("trades ahead", (pL + W - pR) / 2, H - 3);
  // the legend goes on the RIGHT: the curves rise left to right, so the top-left
  // corner is the one place on this chart that is always empty
  ctx.textAlign = "right";
  ([["p99", css("--stop-ink"), pT + 8], ["p90", css("--ink"), pT + 20], ["p50", css("--muted"), pT + 32]] as [string, string, number][])
    .forEach(([lbl, col, y]) => { ctx.fillStyle = col; ctx.fillText(lbl, W - pR - 4, y); });
  ctx.textAlign = "left";
  cv.classList.add("tippable");
  chartTip(cv, (x, _y, w) => {
    const t = Math.exp(xLo + ((x - pL) / Math.max(1, w - pL - pR)) * (xHi - xLo));
    if (!isFinite(t)) return null;
    let bi = 0, bd = 1e18;
    pts.forEach((p, i) => { const d = Math.abs(Math.log(p.horizon) - Math.log(t)); if (d < bd) { bd = d; bi = i; } });
    const p = pts[bi];
    return "over " + p.horizon + " trades<br><b>p50 " + p.p50.toFixed(1) + "R &middot; p90 " + p.p90.toFixed(1) +
      "R &middot; p99 " + p.p99.toFixed(1) + "R</b>";
  });
}

function renderValidate() {
  const looks = edgeLooks(), conf = edgeConf(), z = zFor(conf);
  const { n, nEff, note: nNote, basis } = edgeN();
  // WIN RATE, one definition everywhere: wins as a share of DECIDED trades. The
  // headline used to round S.p while the interval was built on a different count
  // and the journal quoted a third figure; all three now come from these two
  // numbers, rounded once, and the label states the definition.
  const p = S.p;
  const nDec = Math.max(1, Math.round(n * (1 - S.s)));
  // the interval is built on the EFFECTIVE decided count - discounting the
  // sample has to reach the win rate too, not only expectancy
  const nDecEff = Math.max(1, nDec * (nEff / Math.max(1, n)));
  const wr = wilsonAt(p, nDecEff, conf);
  const sd = sigmaR(), mu = expectancy();
  const seE = sd / Math.sqrt(Math.max(1, nEff));
  const evLo = mu - z * seE, evHi = mu + z * seE;

  // profit factor, resampled at the EFFECTIVE size and read at the same
  // confidence - a downstream number inherits its inputs' uncertainty
  const pf = profitFactor();
  const rnd = mulberry(71);
  const pfs: number[] = [];
  const reps = FAST ? 150 : 700;
  const drawN = Math.max(10, Math.round(nEff));
  for (let i = 0; i < reps; i++) {
    let gw = 0, gl = 0;
    for (let j = 0; j < drawN; j++) { const r = sampleR(rnd); if (r > 0) gw += r; else gl -= r; }
    pfs.push(gl > 0 ? gw / gl : 99);
  }
  pfs.sort((a, b) => a - b);
  const tail = (1 - conf) / 2;
  const pfLo = pfs[Math.floor(reps * tail)], pfHi = pfs[Math.min(reps - 1, Math.floor(reps * (1 - tail)))];

  // Measured value on the face, interval on the sub-line. The whole row used to
  // be one sentence, which is fine in a 1fr column and is three wrapped lines in
  // the 150px one this list actually has - macstats caps every readout at two,
  // and it fails on a Mac's wider mono before it fails here.
  const shrunk = nEff < n - 0.5;
  $("vWR").innerHTML = Math.round(p * 100) + "%" +
    '<div class="sub">' + Math.round(wr.lo * 100) + "&ndash;" + Math.round(wr.hi * 100) + "% true</div>";
  $("vEV").innerHTML = (mu >= 0 ? "+" : "") + mu.toFixed(2) + "R" +
    '<div class="sub">' + (evLo >= 0 ? "+" : "") + evLo.toFixed(2) + " to " + (evHi >= 0 ? "+" : "") + evHi.toFixed(2) + "R</div>";
  $("vEV").className = "v " + (evLo > 0 ? "cell-go" : evHi > 0 ? "cell-caution" : "cell-stop");
  $("vPF").innerHTML = (pf >= 99 ? "very high" : pf.toFixed(2)) +
    '<div class="sub">' + pfLo.toFixed(2) + "&ndash;" + (pfHi >= 99 ? "high" : pfHi.toFixed(2)) + "</div>";
  $("vN").innerHTML = String(n) + (shrunk ? '<div class="sub cell-caution">' + Math.round(nEff) + " effective</div>" : '<div class="sub">independent</div>');
  // the reason the sample was discounted is prose, and prose does not belong in
  // a 150px value column
  $("vNNote").innerHTML = shrunk
    ? n + " trades &asymp; " + Math.round(nEff) + " independent &middot; " + esc(nNote)
    : S.trades ? esc(nNote) : "";
  void basis;

  // ---- the multiplicity banner ----
  const looksBox = $("vLooks");
  looksBox.classList.toggle("hide", looks <= 1);
  if (looks > 1) {
    $("vLooksMsg").innerHTML = "<b>" + looks + "</b> subsets tested with Leave out &middot; ranges widened to <b>" +
      (Math.round(conf * 1000) / 10) + "%</b>.";
  }

  // ---- pooled accounts: near-duplicate observations are not extra evidence ----
  // The Portfolio tab already establishes the point in the other direction:
  // several accounts on one strategy see an IDENTICAL market, so they are one
  // bet, not several. The same fact read backwards is that pooling them into one
  // "record" counts one decision two or three times, and every interval on this
  // screen divides by the square root of that count.
  const poolBox = $("vPool");
  const mirrored = S.meta ? S.meta.mirrored : 0;
  const pooled = !!(S.meta && S.meta.accounts > 1);
  poolBox.classList.toggle("hide", !pooled && mirrored === 0);
  if (pooled || mirrored > 0) {
    $("vPoolMsg").innerHTML =
      (pooled ? "<b>" + S.meta!.accounts + " accounts</b> pooled. " : "") +
      (mirrored > 0
        ? "<b>" + mirrored + "</b> trades mirrored across accounts &mdash; discounted."
        : "If they copy one signal, set Edge source to one account.");
  }

  // ---- the full record beside any cut, so the baseline cannot be replaced silently ----
  const baseBox = $("vBaseline");
  const cutOn = !!(S.meta && S.meta.cutName && S.meta.fullRs);
  baseBox.classList.toggle("hide", !cutOn);
  if (cutOn) {
    const full = S.meta!.fullRs!;
    let fm = 0;
    full.forEach((r) => { fm += r; });
    fm /= full.length;
    let fv = 0;
    full.forEach((r) => { fv += (r - fm) * (r - fm); });
    const fsd = Math.sqrt(Math.max(fv / Math.max(1, full.length - 1), 0.0001));
    const fse = fsd / Math.sqrt(full.length);
    $("vBaselineMsg").innerHTML = "Without <b>" + esc(S.meta!.cutName!) + "</b> removed: <b>" + full.length + "</b> trades, <b>" + (fm >= 0 ? "+" : "") + fm.toFixed(2) +
      "R</b> (" + (fm - z * fse >= 0 ? "+" : "") + (fm - z * fse).toFixed(2) + " to " + (fm + z * fse >= 0 ? "+" : "") + (fm + z * fse).toFixed(2) +
      "R).";
  }

  // ---- verdict ----
  const real = evLo > 0, promising = mu > 0 && !real;
  let col: string, chip: string, vt: string, rt: string;
  if (mu <= 0.001) { col = css("--stop"); chip = "No edge shown"; vt = "No edge"; rt = "Expectancy is not above zero."; }
  // The VERDICT changes below the bar; nothing on this screen goes blank. Every
  // interval, chart and drawdown reading below still prints, and the panels that
  // cite this bar (My firm, the Funded tab's best size) must describe it that
  // way - "will not call an edge real", never "refuses to show you anything".
  else if (n < PLAN_MIN_N) { col = css("--stop"); chip = "Too few trades"; vt = "Not enough data"; rt = "Too few trades to judge. Aim for 100+."; }
  else if (real) {
    col = css("--go"); chip = "Statistically real"; vt = "Likely real";
    rt = "The " + (Math.round(conf * 1000) / 10) + "% range stays above zero.";
  } else if (promising) {
    col = css("--caution"); chip = "Unproven"; vt = "Promising, unproven";
    rt = "Positive average, but the range still crosses zero. Log more trades.";
  } else { col = css("--stop"); chip = "Too few"; vt = "Not enough data"; rt = "Keep logging."; }
  $("vVerdict").textContent = vt; $("vVerdict").style.color = col;
  $("vChip").textContent = chip; $("vChip").style.background = col;
  $("vRead").textContent = rt;
  drawBell(mu, seE, evLo, evHi, conf);
  $("vBellCap").textContent = "Shaded: " + (Math.round(conf * 1000) / 10) + "% range (edges dashed) · red: break-even";

  renderDD(n, nEff);
}

// The drawdown half of the tab.
function renderDD(n: number, nEff: number) {
  const h = ddHorizon(), o = ddOpts();
  setNum("nHz", String(h));
  $i("sHz").value = String(h);
  // the horizon in something a human plans in, using the record's own pace
  const perDay = S.meta && S.meta.days && S.meta.days.length
    ? S.meta.ordered!.length / (new Set(S.meta.days).size)
    : tpdOf();
  const days = Math.round(h / Math.max(0.2, perDay));
  $("lHzSub").textContent = h + " trades ≈ " + days + " trading days ≈ " +
    (days / TRADING_DAYS_PER_MONTH >= 12 ? (days / TRADING_DAYS_PER_YEAR).toFixed(1) + " years" : Math.round(days / TRADING_DAYS_PER_MONTH) + " months") +
    " at " + perDay.toFixed(1) + "/day";

  const limRaw = Number($i("nDDLim").value) || 0;
  const lim = limRaw > 0 ? limRaw : F.maxdd;
  $("lDDLimSub").textContent = limRaw > 0
    ? money((lim / 100) * F.account) + " on " + money(F.account)
    : "0 = " + (view.PROP ? "firm's " : "account's ") + F.maxdd + "% (" + money((F.maxdd / 100) * F.account) + ")";

  document.querySelectorAll<HTMLButtonElement>("button[data-ddm]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.getAttribute("data-ddm") === o.method)));

  const job = ensureDD();
  if (!job) {
    $("ddLadder").className = "statgrid ddlad";
    $("ddLadder").innerHTML = '<div class="tile full"><div class="k">Simulating</div><div class="v vsmall">&hellip;</div></div>';
    $("ddRisk").innerHTML = "";
    $("ddCurveCap").textContent = "";
    return;
  }
  const res = o.method === "block" ? job.block : job.iid;
  const other = o.method === "block" ? job.iid : job.block;
  const at = (r: DDResult) => r.points.find((q) => q.horizon === h) || r.points[r.points.length - 1];
  const pt = at(res), ptOther = at(other);

  // ---- the ladder. No figure without a horizon and a percentile. ----
  const cell = (lbl: string, v: number, sub: string, cls: string) =>
    '<div class="tile ' + cls + '"><div class="k">' + lbl + '</div><div class="v">' + v.toFixed(1) +
    'R</div><div class="pl">' + sub + "</div></div>";
  $("ddLadder").className = "statgrid ddlad";
  $("ddLadder").innerHTML =
    cell("p50 &middot; over " + h, pt.p50, "coin flip", "coin") +
    cell("p75 &middot; over " + h, pt.p75, "1 in 4 worse", "") +
    cell("p90 &middot; over " + h, pt.p90, "size to this", "anchor") +
    cell("p99 &middot; over " + h, pt.p99, "worst case", "anchor");

  drawDDCurve(job, h, o.method);
  $("ddCurveCap").textContent = "Solid p90 · dashed p99 · dotted p50 · vertical = horizon · " + res.runs.toLocaleString() + " runs";

  // ---- method, block length, overshoot: say what was assumed and what it cost ----
  const f = job.fit;
  $("lDDMethod").innerHTML = !serialMeasurable()
    ? "no trade order &mdash; independent only"
    : f.significant
      ? "clustered (lag-1 " + f.rho1.toFixed(2) + ") &middot; block " + f.block + " &middot; independent p90 " + ptOther.p90.toFixed(1) + "R"
      : "no clustering (lag-1 " + f.rho1.toFixed(2) + ") &middot; block 1";
  const ov = job.over;
  $("lOvershoot").innerHTML = !o.overshoot
    ? "off &middot; every loss = " + ov.mean.toFixed(2) + "R"
    : ov.degenerate
      ? "on &middot; all " + ov.losses + " losses are the same size"
      : "on &middot; worst 5% of losses = " + ov.p95.toFixed(2) + "&times; average";

  // ---- the number a prop trader actually needs ----
  const maxR = maxRiskForLimit(pt.p95, lim);
  const curRisk = Number($i("srf").value);
  $("ddRisk").innerHTML = maxR == null
    ? ""
    : '<div class="ddrisk"><div class="rk">Largest risk per trade that fits inside a ' + lim.toFixed(1) + '% account limit</div>' +
      '<div class="rv">' + maxR.toFixed(2) + "%</div>" +
      '<div class="rs">p95 drawdown over ' + h + " trades: <b>" + pt.p95.toFixed(1) + "R</b>" +
      // In prop firm mode this box used to colour the Funded tab's risk green or
      // red against ITS OWN model - every peak-to-trough fall counted against
      // the limit, no daily limit, no withdrawals - while the Funded tab sized
      // the same account against the firm's actual floor. On the sample record
      // the two disagreed by 60% (0.52% here, 0.82% there) with no word on why.
      // Now it states the difference and quotes the Funded tab's answer instead.
      (!view.PROP ? "" : " &middot; this counts every peak-to-trough fall against the limit. The Funded tab applies your firm&rsquo;s own rules " +
        "(where the floor sits, the daily limit, withdrawals), so its sizes differ" +
        (lastBalanced != null ? ": its balanced size is <b>" + lastBalanced.toFixed(2) + "%</b>" : "") +
        ". Your Funded tab risk is " + curRisk.toFixed(2) + "%.") + "</div></div>";
  void n; void nEff;
}

// ---------------- THE EDGE BAND, SHARED BY CHALLENGE / FUNDED / DECISION ------
//
// ONE job, one set of resamples, three tabs. Computing a band per tab would let
// Challenge quote a pass range drawn from one set of imagined records and
// Decision quote an EV range drawn from another - the two would not compose, and
// "77% pass" on one tab could sit beside an EV band that never saw a 77% draw.
// Every resample here is scored end to end, so the three bands are slices of the
// same experiment and the numbers reconcile.
//
// Deferred and chunked one resample per macrotask, like buildPlan and
// scoreFirmsChunked: this is ~120 x (a challenge sweep + a funded sweep + a
// payout sweep), which is seconds of Monte Carlo and would freeze the window if
// it ran inline. Cached on the record, the firm rules and all three risk sizes,
// so it recomputes only when one of them actually moves.
interface EdgeBands { pass: Band; surv: Band; ev: Band; paid: Band; draws: number }
interface BandJob { key: string; bands: EdgeBands }
let bandCache: BandJob | null = null;
let bandPending: string | null = null;
let bandCancel = 0;
// A slider edge carries no sample, so it has no parameter uncertainty to show -
// the sliders ARE the assumption. Bands only exist for a journal record.
// ---------------- ROBUST SIZING, SHARED BY FUNDED AND CHALLENGE (2.18.7) -----
// For each candidate size: the share of ROBUST_DRAWS plausible records (see
// plausibleRecord) whose score clears `bar` - survival for Funded, pass rate for
// Challenge. One record per macrotask through the shared job queue, like the
// band job; render() runs again when it lands. Returns null while pending, and
// never starts during a drag (FAST) - the 250ms settle starts it.
interface RobustSlot { key: string; mat: number[][] | null; seq: number }
const robustSlots: Record<string, RobustSlot> = {};
let lastBalanced: number | null = null;   // the Funded tab's balanced size, for Validate
// One SIZE of one record per slice: a whole record's sizes in one slice put the
// Decision tab's worst main-thread task at 219ms on CI against a 250ms budget.
// scoreAt(i) scores size i under the edge in force; the engine seeds every size
// identically, so per-size calls give exactly the numbers one call would.
// Returns the SCORES, mat[record][size], not pass/fail against one bar: every
// setting that moves a bar (survival target, velocity floor, confidence)
// re-picks from the same matrix instantly, with no re-simulation.
function ensureRobust(kind: string, key: string, n: number, scoreAt: (i: number) => number): number[][] | null {
  const slot = robustSlots[kind] || (robustSlots[kind] = { key: "", mat: null, seq: 0 });
  if (slot.key === key) return slot.mat;
  if (FAST || n <= 0) return null;
  slot.key = key; slot.mat = null;
  const my = ++slot.seq;
  const mat: number[][] = [];
  let drawn = 0, i = 0;
  let rec: number[] = [], row: number[] = [];
  runJob(() => {
    if (my !== slot.seq) return true;
    if (i === 0) { rec = plausibleRecord(9101 + drawn * 0x9e3779b1); row = new Array<number>(n).fill(0); }
    const at = i;
    row[at] = withEdge(rec, () => scoreAt(at));
    if (++i >= n) { i = 0; drawn++; mat.push(row); }
    return drawn >= ROBUST_DRAWS;
  }, () => {
    if (my !== slot.seq) return;
    slot.mat = mat;
    render();
  });
  return null;
}

function bandable(): boolean { return !!(S.trades && S.trades.length >= 20); }
function ensureBands(re: number, rf: number): EdgeBands | null {
  if (!bandable()) return null;
  const key = edgeFp() + "|" + firmRulesKey(F) + "|" + F.account + "|" + F.split + "|" + F.fee +
    "|" + re.toFixed(2) + "|" + rf.toFixed(2);
  if (bandCache && bandCache.key === key) return bandCache.bands;
  if (bandPending === key) return null;
  bandPending = key;
  const mySeq = ++bandCancel;
  const rs = S.trades as number[];
  // More draws at lower per-draw precision is both the statistically right
  // allocation for a PERCENTILE of the sampling distribution and the kinder one
  // for the main thread: the band is about spread across records, not precision
  // within one. At these counts a draw is ~5-10ms, which fits a slice.
  const DRAWS = 150;
  const pass: number[] = [], surv: number[] = [], ev: number[] = [], paid: number[] = [];
  const hc = Math.max(0, Math.min(0.5, LS.get<number>("pel_haircut", 0)));
  let drawn = 0;
  const step = (): boolean => {
    if (mySeq !== bandCancel) return true;
    const i = drawn++;
    // Counts are deliberately lower than the headline's: a band needs many
    // records at moderate precision, not one record at high precision, and the
    // point estimate on screen is still the full-count one.
    withEdge(resampleRecord(rs, 8100 + i * 0x9e3779b1), () => {
      const st = challengeStats(re, 120);
      const p = F.instant ? 1 : evalPass(st);
      const fs = fundedStats(rf, 60, yearSteps());
      const po = payoutOdds(rf, 80, yearSteps());
      const cf = costToFund(p, F.instant ? 0 : st.meanDaysAll);
      pass.push(p);
      surv.push(fs.surv);
      paid.push(p * po.p);
      ev.push((((fs.profit / 100) * F.account * F.split) / 100) * (1 - hc) - cf.cost);
    });
    return drawn >= DRAWS;
  };
  runJob(step, () => {
    if (mySeq !== bandCancel) return;
    bandCache = { key, bands: {
      pass: bandOf(pass), surv: bandOf(surv), ev: bandOf(ev), paid: bandOf(paid), draws: DRAWS,
    } };
    bandPending = null;
    render();
  });
  return null;
}
// the sub-line every banded headline carries, or a quiet "still measuring"
function bandSub(b: Band | null, fmt: (v: number) => string, pending: string): string {
  if (!bandable()) return "";
  if (!b) { void pending; return '<div class="sub"><span class="skel"></span></div>'; }
  return '<div class="sub">' + bandText(b, fmt) + "</div>";
}

// ---------------- CHALLENGE ----------------
function setChallengePhase(p: number) {
  CPHASE = p === 2 ? 2 : 1;
  document.querySelectorAll<HTMLButtonElement>("button[data-cphase]").forEach((b) =>
    b.setAttribute("aria-pressed", String(Number(b.getAttribute("data-cphase")) === CPHASE)));
}
// `phase` is 1 or 2, and phase 2 is drawn UNCONDITIONALLY rather than only over
// the runs that cleared phase 1 - which is correct, not a shortcut. phaseWalk
// restarts phase 2 from zero equity with a fresh peak and the full drawdown room
// (engine.ts), and the R stream is iid, so clearing phase 1 tells you nothing
// about the draws that follow. The phase-2 population IS the unconditional one;
// only the target moves.
function drawPaths(risk: number, phase: number) {
  const g = fit($c("cPaths")), ctx = g.ctx, W = g.w, H = g.h, pT = 16, pB = 14, pL = 6, pR = 6;
  ctx.clearRect(0, 0, W, H);
  const tgt = phase === 2 ? F.p2 : F.p1, flr = -F.maxdd, top = tgt * 1.15, bot = flr * 1.2;
  const Y = (v: number) => pT + ((top - v) / (top - bot)) * (H - pT - pB);
  ctx.strokeStyle = css("--go"); ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(pL, Y(tgt)); ctx.lineTo(W - pR, Y(tgt)); ctx.stroke(); ctx.setLineDash([]);
  // Paths are RECORDED, so the memory here is (paths x steps), and steps is
  // maxDays * tpd. At the default 5/day that is 2,500 a path and 1,000 paths is
  // ~20MB of transient array - fine. tpd is clamped at 20 now, but 20 would still
  // be 10,000 a path and 200MB, which is an out-of-memory crash rather than a
  // slow chart. Bound the TOTAL recorded points instead of the path count, so
  // the chart costs the same wherever the day clock is set; a denser day just
  // draws fewer sample paths, which is the right thing to give up.
  const stepsPer = evalDays() * tpdOf();
  const NP = FAST ? 150 : Math.max(120, Math.min(1000, Math.floor(2500000 / Math.max(1, stepsPer))));
  const rnd = mulberry(PATH_SEED);
  let maxLen = 30;
  const res: WalkOut[] = [];
  for (let i = 0; i < NP; i++) { const r = phaseWalk(tgt, risk, rnd, true); res.push(r); if (r.path!.length > maxLen) maxLen = r.path!.length; }

  // ---- THE FLOOR IS A STEP FUNCTION, AND THIS CHART USED TO DRAW IT FLAT ----
  //
  // One straight line at -maxdd is correct only for a STATIC firm and only on day
  // one of any other. On a trailing firm the floor ratchets up behind every new
  // high, which is the whole reason the three drawdown regimes score differently
  // - and the chart was drawing the harshest rule in the app as though it were
  // the mildest. Measured over this chart's own seeded paths, 77-90% of the red
  // drawdown failures terminated ABOVE the line that supposedly killed them: the
  // picture contradicted the simulation it was drawn from.
  //
  // Reconstructed here rather than returned by the engine, because it is an exact
  // function of the recorded path and adding a second array to every walk would
  // cost memory on 1,000 paths to re-derive what is already there. Mirrors
  // phaseWalk exactly: peak updates BEFORE the floor check (engine.ts:111-113),
  // and the end-of-day peak only after the rollover that follows it (:123), so
  // path index j is an end-of-day close when j % tpd === 0.
  const tpdN = tpdOf();
  const floorSeries = (path: number[]): number[] => {
    const out = new Array<number>(path.length);
    let peak = 0, peakEod = 0;
    for (let k = 0; k < path.length; k++) {
      if (k > 0 && path[k] > peak) peak = path[k];
      const base = F.ddType === "trailing-eod" ? peakEod : peak;
      out[k] = F.ddType === "static" ? -F.maxdd : F.ddLock ? Math.min(base - F.maxdd, 0) : base - F.maxdd;
      if (k >= tpdN && k % tpdN === 0 && path[k] > peakEod) peakEod = path[k];
    }
    return out;
  };
  // the TYPICAL floor at each step, over the runs still alive there. Survivorship
  // is the honest framing: "of the attempts still going at trade k, the floor had
  // ratcheted to about here".
  const ratchets = F.ddType !== "static";
  const medFloor: number[] = [];
  if (ratchets) {
    const series = res.map((r) => floorSeries(r.path!));
    for (let k = 0; k < maxLen; k++) {
      const at: number[] = [];
      series.forEach((s) => { if (k < s.length) at.push(s[k]); });
      if (!at.length) { medFloor.push(medFloor[medFloor.length - 1] ?? flr); continue; }
      at.sort((a, b) => a - b);
      medFloor.push(at[(at.length * 0.5) | 0]);
    }
  }
  ctx.strokeStyle = css("--stop"); ctx.lineWidth = 2;
  if (ratchets) {
    // day one, dashed, as the reference the number on the firm card names...
    ctx.setLineDash([4, 4]); ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(pL, Y(flr)); ctx.lineTo(W - pR, Y(flr)); ctx.stroke();
    ctx.setLineDash([]);
    // ...and where it actually went
    ctx.lineWidth = 2; ctx.beginPath();
    medFloor.forEach((v, k) => {
      const x = pL + ((W - pL - pR) * k) / maxLen, y = Y(Math.max(bot, Math.min(top, v)));
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  } else {
    ctx.beginPath(); ctx.moveTo(pL, Y(flr)); ctx.lineTo(W - pR, Y(flr)); ctx.stroke();
  }
  ctx.font = "10px " + css("--mono"); ctx.textAlign = "left";
  ctx.fillStyle = css("--go-ink"); ctx.fillText("target " + amt(tgt), pL + 2, Y(tgt) - 4);
  ctx.fillStyle = css("--stop-ink");
  ctx.fillText(ddLabel(F) + " floor " + amt(-F.maxdd) + (ratchets ? " on day one" : ""), pL + 2, Y(flr) + 12);
  if (ratchets) {
    const last = medFloor[medFloor.length - 1] ?? flr;
    ctx.textAlign = "right";
    ctx.fillText("typical floor once it has ratcheted", W - pR - 2, Y(Math.max(bot, Math.min(top, last))) - 5);
    ctx.textAlign = "left";
  }
  function drawSet(match: WalkOut["res"], col: string, alpha: number) {
    ctx.strokeStyle = col; ctx.globalAlpha = alpha; ctx.lineWidth = 1;
    res.forEach((r) => {
      if (r.res !== match) return;
      const path = r.path!;
      const stride = Math.max(1, Math.ceil(path.length / 200));
      ctx.beginPath();
      for (let k = 0; k < path.length; k += stride) {
        const x = pL + ((W - pL - pR) * k) / maxLen;
        let v = path[k]; if (v > top) v = top; if (v < bot) v = bot;
        if (k === 0) ctx.moveTo(x, Y(v)); else ctx.lineTo(x, Y(v));
      }
      const le = path.length - 1;
      let ve = path[le]; if (ve > top) ve = top; if (ve < bot) ve = bot;
      ctx.lineTo(pL + ((W - pL - pR) * le) / maxLen, Y(ve));
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
  }
  drawSet("timeout", css("--muted"), 0.04);
  drawSet("ddfail", css("--stop"), 0.05);
  drawSet("dailyfail", css("--caution"), 0.06);
  drawSet("pass", css("--go"), 0.06);
  // NP is not a constant - it is bounded by total recorded POINTS, so a denser
  // day clock draws fewer paths (see above). The heading used to be the literal
  // string "1,000 simulated attempts" in the markup, which was only true at the
  // default tpd; it is written from the count actually drawn.
  $("cPathsTitle").textContent = NP.toLocaleString() + " simulated attempts" +
    (F.type === "2step" && F.p2 > 0 ? " (phase " + phase + ")" : "");
}
// ---- AN ATTEMPT IS THE WHOLE EVALUATION, NOT ITS FIRST GATE ----
//
// This chart used to plot st.pass/dd/dl/to, which are all PHASE 1. On a 2-step
// firm that meant a run which cleared phase 1 and then blew the drawdown in
// phase 2 was painted in the green "pass" bar, and the phase-2 deaths appeared
// nowhere at all: the panel could read "97% pass, 0% drawdown" beside a headline
// saying 91% clear both phases. Now the green bar is the end-to-end number and
// each failure bar carries both phases, the phase-2 share drawn as a lighter
// block on the end of the phase-1 one so the split is visible without a fifth
// row. The seven terminal outcomes sum to 1 by construction (see ChallengeOut).
function drawOutcomes(st: ChallengeOut) {
  const g = fit($c("cOut")), ctx = g.ctx, W = g.w, H = g.h, pL = 6, pR = 6, pT = 8, pB = 8;
  ctx.clearRect(0, 0, W, H);
  const twoStep = F.type === "2step" && F.p2 > 0;
  const segs = [
    { v: twoStep ? st.both : st.pass, v2: 0, c: css("--go"), t: "pass" },
    { v: st.dd + st.dd2, v2: twoStep ? st.dd2 : 0, c: css("--stop"), t: "drawdown" },
    { v: st.dl + st.dl2, v2: twoStep ? st.dl2 : 0, c: css("--caution"), t: "daily" },
    { v: st.to + st.to2, v2: twoStep ? st.to2 : 0, c: css("--muted"), t: "timeout" },
  ];
  let y = pT;
  const bh = (H - pT - pB - 3 * 8) / 4;
  ctx.font = "10px " + css("--mono");
  segs.forEach((s) => {
    const bw = W - pL - pR - 70;
    ctx.fillStyle = css("--panel"); ctx.fillRect(pL, y, bw, bh);
    ctx.fillStyle = s.c; ctx.fillRect(pL, y, bw * (s.v - s.v2), bh);
    // the phase-2 slice, mixed toward the canvas rather than alpha-blended so it
    // reads as the same cause at a lighter weight on every theme
    if (s.v2 > 0) {
      ctx.fillStyle = mixHex(s.c, css("--panel"), 0.55);
      ctx.fillRect(pL + bw * (s.v - s.v2), y, bw * s.v2, bh);
    }
    ctx.fillStyle = css("--ink"); ctx.textAlign = "left";
    ctx.fillText(Math.round(s.v * 100) + "% " + s.t, pL + bw + 6, y + bh / 2 + 3);
    y += bh + 8;
  });
}
function drawHist(st: ChallengeOut) {
  const cv = $c("cHist");
  const g = fit(cv), ctx = g.ctx, W = g.w, H = g.h, pL = 6, pR = 6, pT = 8, pB = 18;
  ctx.clearRect(0, 0, W, H);
  const a = st.daysArr;
  if (!a.length) {
    ctx.fillStyle = css("--muted"); ctx.font = "11px " + css("--mono"); ctx.textAlign = "center";
    ctx.fillText("no passes", W / 2, H / 2);
    return;
  }
  const maxD = a[a.length - 1] || 1, bins = 12;
  const counts = new Array(bins).fill(0) as number[];
  a.forEach((d) => { counts[Math.min(bins - 1, ((d / maxD) * bins) | 0)]++; });
  const cmax = Math.max(...counts) || 1, bw = (W - pL - pR) / bins;
  for (let i = 0; i < bins; i++) {
    const bh = (counts[i] / cmax) * (H - pT - pB);
    ctx.fillStyle = css("--go"); ctx.fillRect(pL + i * bw + 1, H - pB - bh, bw - 2, bh);
  }
  ctx.fillStyle = css("--muted"); ctx.font = "9px " + css("--mono"); ctx.textAlign = "center";
  ctx.fillText("0", pL + 2, H - 6);
  ctx.fillText(maxD + " days", W - pR - 14, H - 6);
  cv.classList.add("tippable");
  chartTip(cv, (x, _y, w) => {
    const i = Math.floor(((x - pL) / Math.max(1, w - pL - pR)) * bins);
    if (i < 0 || i >= bins || !counts[i]) return null;
    const a = Math.round((i / bins) * maxD), b2 = Math.round(((i + 1) / bins) * maxD);
    return a + "&ndash;" + b2 + " days<br><b>" + Math.round((counts[i] / a2Len(counts)) * 100) + "%</b> of passes";
  });
}
function a2Len(counts: number[]): number {
  let s = 0;
  counts.forEach((c) => { s += c; });
  return s || 1;
}
function renderChallenge() {
  const risk = Number($i("src").value);
  setNum("nrc", $i("src").value);
  $("lrcSub").textContent = riskSub(risk);
  // 2600/600, the same tiers as the Decision tab - the two tabs quoted slightly
  // different pass odds for the identical inputs from nothing but sim count
  const st = challengeStats(risk, FAST ? 600 : 2600);
  // An INSTANT-funded firm has no evaluation: the fee buys the account. The
  // engine still simulated the stand-in target as though it were a gate, so this
  // tab quoted "54% chance to pass" for a firm the Decision tab one click away
  // correctly described as having no evaluation at all. Certainty in, certainty
  // out - the same treatment finishOdds and portfolioEval already give it.
  const inst = !!F.instant;
  // pctEst, not a bare percentage: this app's own rule is that a Monte Carlo
  // estimate never earns "100%" next to a spending decision, and this headline
  // is the number the decision is made on
  // The band across the record's OWN uncertainty. At the low end of the same
  // win-rate interval Validate prints, this firm's pass rate falls 97% -> 77% -
  // a one-in-four failure rate that used to be shown as one-in-thirty-three.
  const bands = ensureBands(risk, Number($i("srf").value));
  // ---- THE HEADLINE IS END TO END, BECAUSE EVERYTHING AROUND IT ALREADY WAS ----
  //
  // It used to print st.pass under the label "chance to pass phase 1" while the
  // band beneath it and the Strong/Shaky badge were both computed from the
  // END-TO-END rate (ensureBands scores evalPass), and the Decision tab, the
  // Firms table and costToFund all price the same end-to-end number. So a 2-step
  // firm showed a phase-1 point estimate stacked on a both-phases range, one
  // above the other, as though they were the same quantity. They are not: on a
  // 90%/90% pair they are 15 points apart. The per-phase ladder below now carries
  // what the old headline was trying to say, labelled as the conditional it is.
  const twoStep = F.type === "2step" && F.p2 > 0;
  const pEnd = evalPass(st);
  $("cPass").innerHTML = inst
    ? 'no evaluation<span class="u">the fee buys the account outright</span>'
    : pctEst(pEnd) + '<span class="u">chance to ' + (twoStep ? "clear both phases" : "pass the evaluation") + "</span>";
  $("cPass").style.color = inst ? css("--go") : color(pEnd);
  $("cPassBand").innerHTML = inst ? "" : bandSub(bands ? bands.pass : null, pctEst, "measuring the range&hellip;");
  const meter = $("cMeter");
  meter.style.width = inst ? "100%" : Math.round(pEnd * 100) + "%";
  meter.style.background = inst ? css("--go") : color(pEnd);
  // THE BADGE READS THE LOWER BOUND, not the point estimate. "Strong" is a claim
  // about what you can rely on, and the thing you can rely on is the bottom of
  // the range - a 97% point estimate whose band reaches 77% is not a strong bet,
  // it is an uncertain one. With no journal record there is no band, and the
  // point estimate is all there is.
  const judged = inst ? 1 : bands ? bands.pass.lo : pEnd;
  $("cChip").textContent = inst ? "Instant funding" : judged >= 0.85 ? "Strong" : judged >= 0.55 ? "Shaky" : "Unlikely";
  $("cChip").style.background = inst ? css("--go") : color(judged);
  // Three states, not two. "No band" and "band still computing" are different
  // facts and the tooltip used to report both as the first one - so for the few
  // seconds the resamples take, a journal-driven badge claimed it was reading a
  // slider edge.
  $("cChip").title = inst ? ""
    : bands
      ? "Graded on the LOW end of your record's own 90% range (" + pctEst(bands.pass.lo) + "), not on the " +
        pctEst(pEnd) + " point estimate. The point estimate assumes your measured edge is exactly right."
      : bandable()
        ? "Still measuring your record's range - graded on the point estimate until it lands."
        : "Graded on the point estimate - a slider edge carries no sample, so there is no range to take the low end of.";
  // ---- THE PER-PHASE LADDER ----
  //
  // One "clear both phases" figure cannot tell a trader WHICH gate is costing
  // them, and the product hides asymmetry: 95% then 85% and 85% then 95% both
  // land on 81%, and they call for opposite changes. Both gates get a line, the
  // second one stated as the conditional it is - phase 2 is only ever attempted
  // by the runs that cleared phase 1, so its rate is out of those, not out of
  // every attempt. Everything here goes through pctEst for the same reason the
  // headline does: this row used to print a bare Math.round, which is how a
  // "100%" ended up sitting above a ">99%" it cannot exceed.
  $("cRowP1").classList.toggle("hide", !twoStep || inst);
  $("cRowP2").classList.toggle("hide", !twoStep || inst);
  if (twoStep && !inst) {
    $("cP1").textContent = pctEst(st.pass);
    // "0%" and "nobody got that far" are different facts and only one of them is
    // measured; with no attempt reaching phase 2 there is nothing to average
    $("cP2").innerHTML = st.pass > 0
      ? pctEst(st.pass2) + '<div class="sub">of the attempts that get there</div>'
      : '<span class="muted">no attempt got there</span>';
  }
  // "days" alone read as calendar days beside a firm field that also said days;
  // these are trading days, and for a 2-step firm the sum of both phases
  // ...AND THE PACE THEY WERE COUNTED AT. tpd is the day clock for the whole
  // engine (phaseWalk rolls the day every tpd trades), so this number swings 7.7x
  // across the settings the firm editor allows - measured 23 / 12 / 8 / 6 / 5 / 4
  // / 3 / 3 days at tpd 1/2/3/4/5/6/8/10 on one edge. It was the only modelled
  // input absent from every always-visible line on this tab, which made "18
  // trading days" read as a property of the edge rather than of a field behind a
  // collapsed panel.
  $("cDays").innerHTML = st.medDays
    ? st.medDays + " trading days" + (twoStep ? " (both phases)" : "") +
      '<div class="sub">at ' + tpdOf() + " trade" + (tpdOf() === 1 ? "" : "s") + " a day</div>"
    : "n/a";
  const mu = expectancy();
  // The old line said "cutting risk lifts these odds a lot" for every case that
  // was not already comfortable - including the cases where it is false. Under a
  // min-days or time-limit squeeze a SMALLER size is slower and passes less
  // often, and when the two rules cannot both be met no size passes at all. So
  // the advice is now derived, not assumed: measure a smaller size and say what
  // actually happens.
  const days = evalDays();
  const unpassable = F.minDays > 0 && days > 0 && F.minDays > days;
  let read: string;
  if (inst) {
    read = "There is no evaluation to pass at this firm - the fee buys a funded account outright. Size for the funded rules on the next tab.";
  } else if (unpassable) {
    read = "These rules cannot be met at any size: the firm asks for " + F.minDays +
      " trading days inside a " + days + "-day limit. Check the min-days and time-limit fields.";
  } else if (mu <= 0) {
    read = "With no positive edge, passing is a coin flip at best. Fix the edge first.";
  } else if (pEnd >= 0.85) {
    read = "Comfortable at this size. Smaller is even safer, just slower.";
  } else {
    // does smaller actually help HERE? cheap probe at 60% of the current size,
    // measured end to end like everything else on the tab - on a 2-step firm the
    // verdict was read off phase 1 while the headline it explains was not
    const smaller = evalPass(challengeStats(Math.max(0.1, risk * 0.6), FAST ? 200 : 600));
    read = smaller > pEnd + 0.02
      ? "Too big. Smaller risk lifts these odds a lot."
      : smaller < pEnd - 0.02
        ? "Smaller is worse here: the time limit or min days binds."
        : "Size isn't the lever. The rules or your edge are.";
    // which gate is the expensive one is a question a 2-step firm can answer, and
    // it changes what you do: a phase-2 problem is a sizing/clock problem on a
    // SMALLER target, not the same advice again
    if (twoStep && st.pass > 0) {
      read += st.pass2 < st.pass - 0.05
        ? " Phase 2 is the harder gate (" + pctEst(st.pass2) + " vs " + pctEst(st.pass) + ")."
        : st.pass < st.pass2 - 0.05
          ? " Phase 1 is the harder gate (" + pctEst(st.pass) + " vs " + pctEst(st.pass2) + ")."
          : "";
    }
  }
  $("cRead").textContent = read;
  // the phase selector only means anything on a 2-step firm, and a stale "Phase 2"
  // selection must not survive a switch to a single-gate one
  if (!twoStep && CPHASE !== 1) setChallengePhase(1);
  $("cPhaseSeg").classList.toggle("hide", !twoStep);
  // the split is named in words, because a two-tone bar is only legible once you
  // know what the second tone is. "Faded", not "lighter": the second tone is
  // mixed toward the PANEL, so it is lighter on Daylight and Parchment and
  // darker on Carbon and Midnight - a legend that names a direction would be
  // wrong on four of the six colour schemes.
  const p2Fail = st.dd2 + st.dl2 + st.to2;
  $("cOutLeg").classList.toggle("hide", !twoStep || p2Fail <= 0);
  $("cOutLeg").innerHTML = twoStep && p2Fail > 0
    ? "Solid = phase 1 · faded = phase 2 (" + pctEst(p2Fail) + " of attempts)"
    : "";
  drawPaths(risk, twoStep ? CPHASE : 1); drawOutcomes(st); drawHist(st);
}

// ---------------- FUNDED ----------------
// `pays` holds the raw per-run withdrawal counts at every size, so the payout
// goal is answered by counting cached samples rather than re-simulating. The
// cache key deliberately excludes the goal, the haircut, the account size and
// the split: all four are display-time arithmetic over these same samples.
interface GCache { key?: string; risks: number[]; prof: number[]; surv: number[]; pays: number[][] }
let gCache: GCache = { risks: [], prof: [], surv: [], pays: [] };
// The balanced search runs on a finer grid (0.06%) than the curve (0.12%): its
// answer sits where survival crosses a bar, and on the coarse grid it jumped a
// whole step for want of the point between (0.58% fails, so 0.46% at 70% of max
// profit, where 0.52% holds at 81%). Point survival and profit at the fine sizes
// come from one full-count run on the record itself, cached per edge and firm.
// Through the job queue, ONE size per slice: run whole it is ~4M walk steps and
// blocked the window for 349ms on CI (tests/perftest.cjs, budget 250ms).
// fundedCurve seeds every size's runs identically, so computing one size per
// call gives exactly the numbers one call over all sizes would.
interface FineCurve { sizes: number[]; prof: number[]; surv: number[]; paysMean: number[] }
let fineCache: (FineCurve & { key: string }) | null = null;
let finePending = "";
function fineCurve(key: string, top: number): FineCurve | null {
  if (fineCache && fineCache.key === key) return fineCache;
  if (FAST || finePending === key) return null;
  finePending = key;
  const sizes: number[] = [];
  for (let r = 0.1; r <= top + 1e-9; r += 0.06) sizes.push(Math.round(r * 100) / 100);
  const prof: number[] = [], surv: number[] = [], paysMean: number[] = [];
  let k = 0;
  runJob(() => {
    if (finePending !== key) return true;
    const c = fundedCurve([sizes[k]], 240, yearSteps());
    const cs = c.pays[0] || [];
    prof.push(c.prof[0]); surv.push(c.surv[0]);
    paysMean.push(cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : 0);
    return ++k >= sizes.length;
  }, () => {
    if (finePending !== key) return;
    finePending = "";
    fineCache = { key, sizes, prof, surv, paysMean };
    render();
  });
  return null;
}
// One withdrawal in dollars, after the split and the user's haircut - the unit a
// payout goal is quantised to, since the model only ever withdraws whole chunks.
// Shared by renderFunded and the goal control so the two can never disagree.
function payChunk$(): number {
  const hc = Math.max(0, Math.min(0.5, LS.get<number>("pel_haircut", 0)));
  return (((PAY_CHUNK / 100) * F.account * F.split) / 100) * (1 - hc);
}
// The goal is STORED yearly whatever period the user types in, because the
// horizon everything else on this tab is measured over is a year. "Per month" is
// an input convenience - x12 on the way in, /12 on the way out - and the caveat
// line says so, because payouts are lumpy: a drawdown month pays nothing and the
// month after it pays twice. An annual total is a thing this model can stand
// behind; a monthly salary is not.
const goalPeriod = () => (LS.get<string>("pel_pay_goal_period", "mo") === "yr" ? "yr" : "mo");
const goalDiv = () => (goalPeriod() === "mo" ? 12 : 1);
// The two ends of the control are in DIFFERENT units - money typed, whole
// payouts dragged - so wireNum cannot pair them. Money is authoritative:
// dragging writes money, typing only repositions the slider, so a typed figure
// is never silently rounded up to the next whole payout under the cursor.
function setGoal(yearly: number, fromSlider: boolean) {
  const v = Math.max(0, Math.round(yearly));
  LS.set("pel_pay_goal", v);
  if (fromSlider) $i("nGoal").value = String(Math.round(v / goalDiv()));
  const c = payChunk$();
  $i("sGoal").value = String(c > 0 ? Math.max(0, Math.min(24, Math.round(v / c))) : 0);
  scheduleRender();
}
// How many withdrawals the FIRM's own schedule physically allows inside the
// modelled horizon, independent of the edge. Cadence deliberately does not move
// the EV (see fundedSim), but it is still a hard ceiling on how many times you
// can be paid - and a goal above it is unreachable for a reason no amount of
// risk can fix. Counted in the same trading-day clock firstPayoutSim uses.
function firmPayoutCeiling(): number | null {
  const every = F.payoutEvery || 0;
  if (every <= 0) return null;                       // on demand: no schedule ceiling
  const days = TRADING_DAYS_PER_YEAR;                // the horizon is a fixed year now
  // The first withdrawal cannot land before the firm's gate OR before the model's
  // own sweep habit, whichever is later - firstPayoutSim uses exactly this floor.
  // Without it the ceiling counted a payout on day 0 and claimed 151 windows
  // inside a 150-day year.
  const first = Math.max(F.payoutFirst || 0, SWEEP_HABIT_DAYS);
  if (days < first) return 0;
  // and no firm schedule can beat the sweep habit, so a daily-payout firm is
  // still capped by how often this model withdraws at all
  const spacing = Math.max(every, SWEEP_HABIT_DAYS);
  return Math.floor((days - first) / spacing) + 1;
}
// Fingerprint the trade CONTENT, not just its length: keying on length alone
// left the profit-vs-risk curve and its "peak %" sizing advice stale for the
// rest of the session after correcting a trade's P&L. Both size curves cache on
// it, so it lives in one place - two copies would drift and only one of the
// curves would go stale, which is the harder bug to see.
function edgeFp(): string {
  if (!S.trades) return S.p.toFixed(3) + "_" + S.b.toFixed(3) + "_" + S.s.toFixed(3);
  let sum = 0, sq = 0;
  for (const r of S.trades) { sum += r; sq += r * r; }
  return "t" + S.trades.length + "_" + sum.toFixed(3) + "_" + sq.toFixed(3);
}
// What replacing a blown funded account costs, and how long it takes: the
// expected cost to get funded (fees, retries, resets - costToFund, as on the
// Challenge and Decision tabs) at the Challenge tab's eval risk, and the
// expected days to pass (failed attempts' mean days, then a winner's median -
// the same arithmetic as Decision's budget tiles). Cached per firm and edge.
interface Replace { cost: number; pct: number; fundSteps: number; days: number }
let replaceCache: (Replace & { key: string }) | null = null;
function replaceCost(): Replace {
  const re = Number($i("src").value);
  const hc = Math.max(0, Math.min(0.5, LS.get<number>("pel_haircut", 0)));
  const key = firmRulesKey(F) + "|" + F.account + "|" + F.split + "|" + F.fee + "|" + edgeFp() + "|" + re.toFixed(2) + "|" + hc;
  if (replaceCache && replaceCache.key === key) return replaceCache;
  const st = challengeStats(re, FAST ? 300 : 800);
  const p = F.instant ? 1 : evalPass(st);
  const cf = costToFund(p, F.instant ? 0 : st.meanDaysAll);
  const days = F.instant ? 0 : Math.max(0, Math.round(Math.max(0, cf.attempts - 1) * st.meanFailDays + st.medDays));
  // in the curve's own unit: % of account, before the split and haircut, so a
  // replacement and a withdrawal subtract like for like
  const per1pct = (F.account * (F.split / 100) * (1 - hc)) / 100;
  const r: Replace = { cost: cf.cost, pct: per1pct > 0 ? cf.cost / per1pct : 0, fundSteps: days * tpdOf(), days };
  if (!FAST) replaceCache = { key, ...r };
  return r;
}

// ---------------- THE FUNDED OPTIMIZER MODEL (2.19.0) ----------------
// One model, read by the Funded tab (chart, tiles, suggestions, several
// accounts) and by the Decision tab's plans, so the two can never name
// different sizes for the same edge, firm and settings.
function ensureCurve(): GCache {
  // every rule fundedSim reads is in the key: firmRulesKey carries the payout
  // gates and fees, the account size converts the gates to %. The old key left
  // the gates out, so changing one kept a stale curve on screen.
  const key = firmRulesKey(F) + "|" + F.account + "|" + edgeFp();
  // the 21-point risk curve is the expensive part: while dragging, reuse the stale curve
  if (gCache.key !== key && (!FAST || !gCache.risks.length)) {
    const risks = riskGrid();
    // fundedCurve, not fundedStats per point: every size has to replay the same
    // price paths or neighbouring columns are not comparable and the line is
    // mostly reshuffle noise. See the note on fundedCurve.
    const c = fundedCurve(risks, FAST ? 90 : 240, yearSteps());
    gCache = { key, risks, prof: c.prof, surv: c.surv, pays: c.pays };
  }
  return gCache;
}
// The payout goal, stored per year. Never set = one payout a month, a default
// the optimizer can work towards out of the box; typing 0 turns it off.
function goalYearly(): { v: number; isDefault: boolean } {
  const raw = LS.get<number | null>("pel_pay_goal", null);
  if (raw == null || !isFinite(raw)) return { v: 12 * payChunk$(), isDefault: true };
  return { v: Math.max(0, raw), isDefault: false };
}
interface FModel {
  d: GCache; flat: { pk: number; lo: number; hi: number }; pk: number; upto: number;
  noEdge: boolean; thin: boolean; rc: Replace; net: number[];
  fine: FineCurve | null; mat: number[][] | null; fineNet: number[];
  sharesT: number[]; sharesV: number[];
  bal: number; vel: number; maxNet: number;   // fine-grid indices, -1 = none (or pending)
  pending: boolean;
}
function fundedModel(): FModel {
  const d = ensureCurve();
  const o = optSettings();
  const flat = pickFundedSize(d.prof, d.surv).flat;
  const pk = flat.pk;
  // A plateau tolerance is RELATIVE to the peak, so a no-edge curve of MC dust
  // would still print a confident bracket. Under 1% of account per year at the
  // best size, there is nothing to size.
  const noEdge = expectancy() <= 0 || (d.prof[pk] || 0) < 1;
  // A sizing instruction from a record the app will not call an edge is a guess
  // (Validate refuses below 30; slider edges carry no sample).
  const thin = !!S.trades && S.trades.length < PLAN_MIN_N;
  const rc = replaceCost();
  const net = netCurve(d.prof, d.surv, rc.pct);
  // Candidates run up to the top of the gross profit plateau: past it a size
  // pays less AND survives less, so no optimization can land there.
  const upto = flat.hi;
  const fine = noEdge || thin ? null : fineCurve(d.key + "|" + upto, d.risks[upto] ?? 0);
  const mat = !fine ? null : ensureRobust("fund", d.key + "|" + upto + "|fine", fine.sizes.length,
    (i) => fundedCurve([fine.sizes[i]], ROBUST_SIMS, yearSteps()).surv[0]);
  const fineNet = fine ? netCurve(fine.prof, fine.surv, rc.pct) : [];
  const sharesT = mat ? sharesAt(mat, o.survTarget) : [];
  const sharesV = mat ? sharesAt(mat, o.velFloor) : [];
  const ready = !!(fine && mat);
  return {
    d, flat, pk, upto, noEdge, thin, rc, net, fine, mat, fineNet, sharesT, sharesV,
    bal: ready ? pickBalancedAt(fine!.surv, sharesT, fine!.sizes.length - 1, o.survTarget, o.conf) : -1,
    vel: ready ? pickVelocity(fine!.paysMean, fine!.surv, sharesV, fine!.sizes.length - 1, o.velFloor, o.conf) : -1,
    maxNet: fine ? pickMaxNet(fineNet) : -1,
    pending: !noEdge && !thin && !ready,
  };
}
// the trader's dollars for a curve value (% of account a year, before the split)
function pct$(pct: number): number {
  const hc = Math.max(0, Math.min(0.5, LS.get<number>("pel_haircut", 0)));
  return (((pct / 100) * F.account * F.split) / 100) * (1 - hc);
}

// The Goal pick, shared by the tile, the suggestions and the Decision plans:
// the SMALLEST size whose odds of reaching the goal are within 3% of the best
// size's. -1 when the firm's schedule caps it or no size gets 5% odds.
function goalIdx(d: GCache, goal: number): { idx: number; pHit: number[] } {
  const chunk$ = payChunk$();
  if (!(goal > 0 && chunk$ > 0 && d.pays.length)) return { idx: -1, pHit: [] };
  const k = Math.max(1, Math.ceil(goal / chunk$));
  const ceiling = firmPayoutCeiling();
  const pHit = d.pays.map((cs) => (cs.length ? cs.filter((c) => c >= k).length / cs.length : 0));
  if ((ceiling != null && k > ceiling) || Math.max(...pHit) < 0.05) return { idx: -1, pHit };
  return { idx: profitPlateau(pHit, PLATEAU_TOL).lo, pHit };
}
// Every optimization's size, in one list: the chart markers, the Funded
// suggestions table and the Decision plans all read this.
interface Sug { key: string; name: string; why: string; r: number; surv: number; holds: number | null; pays: number; net: number; prof: number; color: string; extra?: string }
function suggestions(m: FModel, goal: number): Sug[] {
  const o = optSettings(), d = m.d, fine = m.fine, out: Sug[] = [];
  if (m.noEdge || m.thin || !fine || !m.mat) return out;
  const fineAt = (r: number) => Math.min(fine.sizes.length - 1, Math.max(0, Math.round((r - 0.1) / 0.06)));
  const at = (i: number) => ({ r: fine.sizes[i], surv: fine.surv[i], holds: m.sharesT[i] ?? 0, pays: fine.paysMean[i], net: m.fineNet[i], prof: fine.prof[i] });
  const gp = goalIdx(d, goal);
  if (gp.idx >= 0) {
    const r = d.risks[gp.idx], fi = r <= fine.sizes[fine.sizes.length - 1] + 1e-9 ? fineAt(r) : -1;
    const cs = d.pays[gp.idx] || [];
    out.push({ key: "goal", name: "Goal", why: "least risk that still reaches your goal", r, surv: d.surv[gp.idx],
      holds: fi >= 0 ? m.sharesT[fi] : null, pays: cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : 0,
      net: m.net[gp.idx], prof: d.prof[gp.idx], color: css("--caution-ink"), extra: pctEst(gp.pHit[gp.idx] || 0) + " odds" });
  }
  if (m.bal >= 0) out.push({ key: "balanced", name: "Balanced", why: Math.round(o.survTarget * 100) + "% survival in " + Math.round(o.conf * 100) + "% of plausible edges", ...at(m.bal), color: css("--go-ink") });
  if (m.vel >= 0) out.push({ key: "velocity", name: "Velocity", why: "most payouts, survival above " + Math.round(o.velFloor * 100) + "%", ...at(m.vel), color: css("--ink") });
  if (m.maxNet >= 0) out.push({ key: "maxnet", name: "Max net", why: "most net profit; no survival bar", ...at(m.maxNet), color: css("--stop-ink") });
  return out;
}

function renderFunded() {
  const risk = Number($i("srf").value);
  setNum("nrf", $i("srf").value);
  $("lrfSub").textContent = riskSub(risk);
  const m = fundedModel();
  const d = m.d, o = optSettings();
  const cur = fundedStats(risk, FAST ? 350 : 1400, yearSteps());
  // ---- one unit for the whole tab: per month (default) or per year ----
  const per = goalPeriod(), div = per === "mo" ? 12 : 1, perW = per === "mo" ? "month" : "year", perS = per === "mo" ? "/mo" : "/yr";
  document.querySelectorAll<HTMLButtonElement>("button[data-goalp]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.getAttribute("data-goalp") === per)));
  $("fProfitLbl").textContent = "Profit / " + perW;
  $("fPaysLbl").textContent = "Payouts / " + perW;
  // the same user haircut every other payout surface applies - the slider's own
  // copy promises "every payout figure", and banked profit IS payout cash
  const hcF = Math.max(0, Math.min(0.5, LS.get<number>("pel_haircut", 0)));
  const hcTag = hcF > 0 ? ", after your " + Math.round(hcF * 100) + "% haircut" : "";
  // headline on its own line, qualifier underneath: the value column is 150px
  $("fProfit").innerHTML = view.DISP === "$"
    ? money(pct$(cur.profit) / div) + '<div class="sub">your split' + hcTag + "</div>"
    : (cur.profit * (1 - hcF) / div).toFixed(per === "mo" ? 1 : 0) + "%" + '<div class="sub">of account' + (hcF > 0 ? ", after haircut" : "") + "</div>";
  $("fProfit").className = "v " + (cur.profit > 0 ? "cell-go" : "cell-stop");
  // The Profit figure above is a MEAN over every fate; this row splits the same
  // runs by how they end (median cash a breaching account withdrew before it
  // died, beside a survivor's). Hidden when nothing breaches.
  const kAbbr = (v: number) => (Math.abs(v) >= 1000 ? "$" + Math.round(v / 100) / 10 + "k" : money(v));
  const bank$ = (pct: number) => view.DISP === "$" ? kAbbr(pct$(pct)) : Math.round(pct * (1 - hcF)) + "%";
  $("fFateRow").classList.toggle("hide", cur.surv >= 0.995);
  if (cur.surv < 0.995) {
    $("fFate").innerHTML = "~" + bank$(cur.bankedDeadMed) + " first" +
      '<div class="sub">survivor ~' + bank$(cur.bankedAliveMed) + "</div>";
    $("fFate").className = "v " + (cur.bankedDeadMed > 0 ? "cell-caution" : "cell-stop");
  }
  // Survival carries the record's own uncertainty like everything else.
  const fBands = ensureBands(Number($i("src").value), risk);
  $("fSurv").innerHTML = pctEst(cur.surv) + bandSub(fBands ? fBands.surv : null, pctEst, "measuring the range&hellip;");
  $("fSurv").className = "v " + (cur.surv >= o.survTarget ? "cell-go" : cur.surv >= 0.5 ? "cell-caution" : "cell-stop");
  // The odds of getting paid come from payoutOdds, the estimator that prices this
  // firm's first-payout wait and minimum (and the one Decision uses).
  const po = payoutOdds(risk, FAST ? 200 : PAID_SIMS, yearSteps());
  $("fPayAny").innerHTML = pctEst(po.p) + (po.medDays ? '<div class="sub">typically ~' + po.medDays + " days to the first</div>" : "");
  $("fPayAny").className = "v " + (po.p >= 0.85 ? "cell-go" : po.p >= 0.5 ? "cell-caution" : "cell-stop");
  const chunk$ = payChunk$();
  const gatedFirm = (F.payoutBuffer || 0) > 0 || (F.payoutCap || 0) > 0 || (F.payoutCapAmt || 0) > 0 || (F.payoutCons || 0) > 0 || (F.winDays || 0) > 0;
  const minBinds = !gatedFirm && firstPayoutPct() > PAY_CHUNK + 1e-9;
  const minNote = minBinds ? ' <b class="cell-caution">· min payout ' + money(F.payoutMin || 0) + "</b>" : "";
  $("fPays").innerHTML = (per === "mo" ? (cur.paysMean / 12).toFixed(1) + " a month" : cur.paysMed + " typical") +
    '<div class="sub">' + (per === "mo" ? cur.paysMed + " typical a year" : cur.paysMean.toFixed(1) + " on average") +
    " · each " + (gatedFirm ? "up to " : "") + (view.DISP === "$" ? money(chunk$) + hcTag : PAY_CHUNK + "% of account") + minNote + "</div>";
  $("fPays").className = "v " + (cur.paysMed >= 1 ? "cell-go" : "cell-stop");

  // ---- the Balanced tile ----
  const fine = m.fine, mat = m.mat;
  const target = Math.round(o.survTarget * 100), holdsTxt = (sh: number) => Math.round(sh * 10) + "/10";
  // a grid size's slot on the fine grid (the fine grid contains every grid size)
  const fineAt = (r: number) => fine ? Math.min(fine.sizes.length - 1, Math.max(0, Math.round((r - 0.1) / 0.06))) : -1;
  lastBalanced = fine && m.bal >= 0 ? fine.sizes[m.bal] : null;
  if (m.noEdge) {
    $("fPeak").textContent = "n/a - no size makes this edge pay";
    $("fPeak").className = "v cell-stop";
    $("fPeak").title = "";
  } else if (m.thin) {
    $("fPeak").innerHTML = "too thin to size" + '<div class="sub">' + (S.trades ? S.trades.length : 0) + " trades · needs " + PLAN_MIN_N + "+</div>";
    $("fPeak").className = "v cell-caution";
    $("fPeak").title = "Validate will not call an edge real below " + PLAN_MIN_N + " resolved trades, so this tab will not issue a sizing instruction derived from one either.";
  } else if (m.pending || !fine || !mat) {
    $("fPeak").innerHTML = '<span class="skel"></span><div class="sub">checking against your edge&rsquo;s range&hellip;</div>';
    $("fPeak").className = "v";
    $("fPeak").title = "";
  } else if (m.bal >= 0) {
    const i = m.bal, r = fine.sizes[i];
    const topNet = m.maxNet >= 0 ? m.fineNet[m.maxNet] : 0;
    const ofTop = topNet > 0 ? Math.max(0, Math.min(100, Math.round((m.fineNet[i] / topNet) * 100))) : 100;
    $("fPeak").innerHTML = r.toFixed(2) + "%" + '<div class="sub">' + Math.round(fine.surv[i] * 100) +
      "% survive &middot; holds " + holdsTxt(m.sharesT[i]) + " &middot; " + ofTop + "% of max</div>";
    $("fPeak").className = "v cell-go";
    $("fPeak").title = "Balanced size: the largest size, up to the top of the profit plateau, whose " + target + "%+ yearly survival holds " +
      "not only at your measured edge but in at least " + Math.round(o.conf * 100) + "% of plausible versions of it. It keeps " + ofTop +
      "% of the most net profit any size makes (payouts minus the cost of replacing a blown account).";
  } else {
    // nothing holds robustly: show the largest size that clears the target at
    // the measured edge, marked fragile - or that nothing clears it at all
    let i = -1;
    for (let k = fine.sizes.length - 1; k >= 0; k--) if (fine.surv[k] >= o.survTarget) { i = k; break; }
    if (i >= 0) {
      $("fPeak").innerHTML = fine.sizes[i].toFixed(2) + "%" + '<div class="sub">fragile &middot; ' + Math.round(fine.surv[i] * 100) + "% only at measured edge</div>";
      $("fPeak").className = "v cell-caution";
      $("fPeak").title = "No size keeps " + target + "+ accounts in 100 alive in " + Math.round(o.conf * 100) + "% of plausible versions of your edge. " +
        fine.sizes[i].toFixed(2) + "% does at the measured edge, but only in " + Math.round((m.sharesT[i] ?? 0) * 100) +
        "% of plausible versions. Treat it as a ceiling, not a target; more trades narrow the range.";
    } else {
      $("fPeak").innerHTML = "none survivable" + '<div class="sub">edge problem, not sizing</div>';
      $("fPeak").className = "v cell-stop";
      $("fPeak").title = "Even the smallest size loses more than " + (100 - target) +
        " accounts in 100 inside a year. No position size fixes that - the edge has to change (or lower the survival target).";
    }
  }

  // ---- payout goal: the SMALLEST size that still gets you there ----
  const gy = goalYearly(), goal = gy.v;
  let gIdx = -1;
  // the slider is in whole payouts, so re-seat it whenever account/split/haircut
  // move the dollar value of one payout under it
  $i("sGoal").value = String(chunk$ > 0 ? Math.max(0, Math.min(24, Math.round(goal / chunk$))) : 0);
  if (document.activeElement !== $i("nGoal")) $i("nGoal").value = String(Math.round(goal / div));
  $("lGoalLbl").textContent = per === "mo" ? "Payout goal $ / month" : "Payout goal $ / year";
  const ceiling = firmPayoutCeiling();
  const needK = chunk$ > 0 ? Math.max(1, Math.ceil(goal / chunk$)) : 0;
  $("lGoalSub").textContent = goal <= 0 ? "0 = off"
    : chunk$ <= 0 ? "set an account size and split first"
      : (gy.isDefault ? "default: one payout a month · " : "") + (per === "mo" ? money(goal) + "/yr = " : "") + needK + " payouts of " + money(chunk$) +
        (ceiling != null && needK > ceiling ? " · firm allows " + ceiling : "") +
        (minBinds ? " · firm min " + money(F.payoutMin || 0) : "");
  let pHit: number[] = [];
  if (goal > 0 && chunk$ > 0 && d.pays.length) {
    const k = Math.max(1, Math.ceil(goal / chunk$));
    pHit = d.pays.map((cs) => (cs.length ? cs.filter((c) => c >= k).length / cs.length : 0));
    const best = Math.max(...pHit);
    $("fGoalRow").classList.remove("hide");
    if (ceiling != null && k > ceiling) {
      // a scheduling wall, not an edge problem - the fix is a different firm or
      // a bigger account, never a bigger size
      $("fGoal").innerHTML = "the firm caps you first" +
        '<div class="sub">' + ceiling + " payouts max on a " + F.payoutEvery + "-day window · you need " + k + "</div>";
      $("fGoal").className = "v cell-stop";
      $("fGoal").title = "Withdrawals here open every " + F.payoutEvery + " trading days" +
        (F.payoutFirst ? ", the first after " + F.payoutFirst : "") +
        ", so at most " + ceiling + " can land inside the modelled year however well you trade. " + money(goal) + " needs " + k + ". More accounts, a bigger account, a faster-paying firm, or a smaller goal.";
    } else if (best < 0.05) {
      $("fGoal").textContent = "out of reach at every size";
      $("fGoal").className = "v cell-stop";
      $("fGoal").title = money(goal) + " is " + k + " payouts of " + money(chunk$) + " - more than this edge produces in a year at any size on one account. Look at Several accounts below, or a bigger account: raising risk lowers the odds from here.";
    } else {
      gIdx = goalIdx(d, goal).idx;
      const hit = pHit[gIdx];
      $("fGoal").innerHTML = (d.risks[gIdx] ?? 0).toFixed(2) + "% risk" +
        '<div class="sub">' + pctEst(hit) + " odds · " + Math.round(d.surv[gIdx] * 100) + "% survival</div>";
      $("fGoal").className = "v " + (hit >= 0.6 ? "cell-go" : hit >= 0.3 ? "cell-caution" : "cell-stop");
      $("fGoal").title = money(goal) + " a year is " + k + " payout" + (k === 1 ? "" : "s") + " of " + money(chunk$) +
        ". This is the smallest size whose odds of getting there are within 3% of the best size's.";
    }
  } else {
    $("fGoalRow").classList.add("hide");
  }

  // ---- settings readout ----
  setNum("nSurvT", String(Math.round(o.survTarget * 100)));
  setNum("nVelF", String(Math.round(o.velFloor * 100)));
  const selC = $s("selConf");
  if (document.activeElement !== selC) selC.value = String(o.conf);
  $("optDefNote").textContent = isDefault(o) ? "using the defaults" : "custom settings";

  // ---- the suggestions: every optimization, side by side ----
  const sugs = suggestions(m, goal);
  void gIdx;
  const fmtNet = (pct: number) => view.DISP === "$" ? money(pct$(pct) / div) : (pct * (1 - hcF) / div).toFixed(1) + "%";
  const curNet = cur.profit - (1 - cur.surv) * m.rc.pct;
  const rowsHtml = sugs.map((g) =>
    '<tr data-sug="' + g.key + '"><td><span class="mk" style="color:' + g.color + '"></span><b>' + g.name + '</b><div class="small muted">' + g.why + "</div></td>" +
    "<td>" + g.r.toFixed(2) + "%</td><td>" + Math.round(g.surv * 100) + "%</td><td>" + (g.holds == null ? "&ndash;" : holdsTxt(g.holds)) + "</td>" +
    "<td>" + (g.pays / div).toFixed(per === "mo" ? 1 : 0) + "</td><td>" + fmtNet(g.net) + (g.extra ? '<div class="small muted">' + g.extra + "</div>" : "") + "</td>" +
    '<td><button type="button" class="usebtn" data-use="' + g.r.toFixed(2) + '">Use</button></td></tr>').join("") +
    '<tr><td><b>Your size</b><div class="small muted">the risk slider</div></td><td>' + risk.toFixed(2) + "%</td><td>" + Math.round(cur.surv * 100) + "%</td><td>&ndash;</td>" +
    "<td>" + (cur.paysMean / div).toFixed(per === "mo" ? 1 : 0) + "</td><td>" + fmtNet(curNet) + "</td><td></td></tr>";
  const tbl = $("optTable");
  if (m.noEdge) tbl.innerHTML = '<p class="small muted">No size makes this edge pay, so there is nothing to optimize.</p>';
  else if (m.thin) tbl.innerHTML = '<p class="small muted">Too few trades to size (needs ' + PLAN_MIN_N + "+).</p>";
  else if (m.pending) tbl.innerHTML = '<span class="skel"></span><p class="small muted">checking every size against your edge&rsquo;s range&hellip;</p>';
  else {
    tbl.innerHTML = '<div class="scroll"><table class="breakdown"><thead><tr><th>Suggestion</th><th>Size</th><th>Survival (1 yr)</th><th title="Share of plausible versions of your edge where this size still clears your survival target">Holds</th><th>Payouts ' + perS +
      '</th><th title="Payouts minus the expected cost of replacing a blown account">Net ' + perS + "</th><th></th></tr></thead><tbody>" + rowsHtml + "</tbody></table></div>";
    tbl.querySelectorAll<HTMLButtonElement>("button[data-use]").forEach((b) => b.addEventListener("click", () => {
      const v = b.getAttribute("data-use") || "";
      $i("srf").value = v;
      $i("srf").dispatchEvent(new Event("input", { bubbles: true }));
    }));
  }
  $("optNote").innerHTML = m.noEdge || m.thin ? "" :
    "Net counts the cost of replacing a blown account: " + money(m.rc.cost) + " to get funded again" +
    (m.rc.days ? " (~" + m.rc.days + " trading days)" : "") + ", at the Challenge tab&rsquo;s " + Number($i("src").value).toFixed(2) + "% eval risk.";

  // ---- the chart: net profit vs size, with every suggestion marked ----
  const cvG = $c("cGrowth");
  const g = fit(cvG), ctx = g.ctx, W = g.w, H = g.h, pL = 44, pR = 12, pT = 12, pB = 28;
  ctx.clearRect(0, 0, W, H);
  const rmin = d.risks[0], rmax = d.risks[d.risks.length - 1];
  const nmax = Math.max(...m.net, ...d.prof.map((v) => v * 0)), ymax = Math.max(nmax * 1.35, 10);
  const nmin = Math.min(0, ...m.net), yspan = ymax - nmin;
  const X = (r: number) => pL + ((r - rmin) / (rmax - rmin)) * (W - pL - pR);
  const Y = (v: number) => pT + (1 - (Math.max(nmin, Math.min(v, ymax)) - nmin) / yspan) * (H - pT - pB);
  // Shade continuously with survival (3-point average: survival vs size is
  // smooth, so column-to-column jitter is sampling error - see the 2026-08-04
  // correction in git history for the measured numbers).
  const sm = d.surv.map((_, i) => {
    const a = d.surv[Math.max(0, i - 1)], b = d.surv[i], c = d.surv[Math.min(d.surv.length - 1, i + 1)];
    return (a + b + c) / 3;
  });
  const bGo = css("--band-go"), bMid = css("--band-mid"), bStop = css("--band-stop");
  const bandAt = (sv: number) => {
    if (sv >= 0.85) return bGo;
    if (sv <= 0.5) return bStop;
    const u = (sv - 0.5) / 0.35;
    return u >= 0.5 ? mixHex(bMid, bGo, (u - 0.5) * 2) : mixHex(bStop, bMid, u * 2);
  };
  const pp = (css("--paper").trim().match(/^#?([0-9a-f]{6})$/i) || [])[1];
  const darkBg = !!pp && (0.299 * parseInt(pp.slice(0, 2), 16) + 0.587 * parseInt(pp.slice(2, 4), 16) + 0.114 * parseInt(pp.slice(4, 6), 16)) < 90;
  ctx.globalAlpha = darkBg ? 0.5 : 1;
  for (let i = 1; i < d.risks.length; i++) {
    ctx.fillStyle = bandAt(sm[i]);
    ctx.fillRect(X(d.risks[i - 1]), pT, X(d.risks[i]) - X(d.risks[i - 1]) + 0.6, H - pT - pB);
  }
  ctx.globalAlpha = 1;
  // zero line when net goes negative (sizes that lose money once replacements are paid)
  if (nmin < 0) {
    ctx.strokeStyle = css("--line-strong"); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(pL, Y(0)); ctx.lineTo(W - pR, Y(0)); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.strokeStyle = css("--ink"); ctx.lineWidth = 2.4; ctx.beginPath();
  d.risks.forEach((r, i) => { const x = X(r), y = Y(m.net[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
  // markers: one dashed line per suggestion, labels staggered so none overlap
  const marks = sugs.map((s2) => ({ x: X(Math.min(rmax, Math.max(rmin, s2.r))), label: s2.name.toLowerCase(), color: s2.color }))
    .sort((a, b) => a.x - b.x);
  ctx.font = "700 10px " + css("--sans"); ctx.textAlign = "center";
  const rows: number[] = [];   // the x of the last label placed on each row
  marks.forEach((mk) => {
    ctx.strokeStyle = mk.color; ctx.lineWidth = 1.8; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(mk.x, pT + 6); ctx.lineTo(mk.x, H - pB); ctx.stroke(); ctx.setLineDash([]);
    const w = ctx.measureText(mk.label).width + 8;
    let row = rows.findIndex((lx) => mk.x - lx >= w);
    if (row < 0) { row = rows.length; rows.push(-1e9); }
    rows[row] = mk.x;
    const ly = H - pB - 6 - row * 12;
    ctx.fillStyle = css("--panel"); ctx.fillRect(mk.x - w / 2, ly - 9, w, 11);
    ctx.fillStyle = mk.color; ctx.fillText(mk.label, mk.x, ly);
  });
  const cx = X(Math.min(rmax, Math.max(rmin, risk)));
  ctx.strokeStyle = css("--go"); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx, pT); ctx.lineTo(cx, H - pB); ctx.stroke();
  ctx.fillStyle = css("--muted"); ctx.font = "10px " + css("--mono"); ctx.textAlign = "center";
  [0.5, 1, 1.5, 2, 2.5, 3].forEach((r) => { if (r >= rmin && r <= rmax) ctx.fillText(r + "%", X(r), H - pB + 15); });
  ctx.fillText("risk per trade", (pL + W - pR) / 2, H - 2);
  ctx.textAlign = "right";
  ctx.fillText("net profit", W - pR - 4, pT + 10);
  ctx.textAlign = "left";
  cvG.classList.add("tippable");
  chartTip(cvG, (x, _y, w) => {
    if (!d.risks.length) return null;
    const r = rmin + ((x - pL) / Math.max(1, w - pL - pR)) * (rmax - rmin);
    if (r < rmin || r > rmax) return null;
    let bi = 0, bd = 1e9;
    d.risks.forEach((rr, i) => { const dd = Math.abs(rr - r); if (dd < bd) { bd = dd; bi = i; } });
    return "risk " + d.risks[bi].toFixed(2) + "% per trade<br><b>net " + fmtNet(m.net[bi]) + " " + perS + "</b>" +
      "<br>payouts " + fmtNet(d.prof[bi]) + " " + perS + " &middot; survival " + Math.round(d.surv[bi] * 100) + "%";
  });

  renderAccounts(m, goal, fmtNet, div, perS);
}

// ---------------- SEVERAL ACCOUNTS (2.19.0) ----------------
// For 1 up to the most accounts you would run: the size that reaches the goal
// with the least risk (or the best net with no goal), and what that setup pays,
// costs and risks as a group. One (count, size) pair per slice of the job queue.
interface AccCache { key: string; rows: PortfolioStat[][] | null }
let accCache: AccCache = { key: "", rows: null };
let accSeq = 0;
function ensurePortfolio(m: FModel, goal: number): PortfolioStat[][] | null {
  const o = optSettings();
  if (!m.fine) return null;
  const bases = m.fine.sizes.filter((_, i) => i % 2 === 0);
  const key = m.d.key + "|" + bases.join(",") + "|" + o.maxAccounts + o.copy + o.ladder + o.rebuy + "|" + m.rc.fundSteps + "|" + Math.round(m.rc.cost) + "|" + Math.round(goal);
  if (accCache.key === key) return accCache.rows;
  if (FAST) return null;
  accCache = { key, rows: null };
  const my = ++accSeq;
  const SIMS = 100, T = yearSteps();
  const out: PortfolioStat[][] = [];
  let n = 1, bi = 0, s = 0;
  let cur: PortfolioStat[] = [];
  let hit = 0, pay = 0, netY = 0, down = 0, reb = 0, alive = 0;
  runJob(() => {
    if (my !== accSeq) return true;
    const base = bases[bi];
    const sizes = ladderSizes(base, n, o.ladder);
    // a few paths per step, fewer the more accounts each path carries: runJob
    // only yields between steps, and 100 paths x 10 accounts is ~1.3M trades
    const stop = Math.min(SIMS, s + Math.max(2, Math.floor(24 / n)));
    for (; s < stop; s++) {
      const path = portfolioSim(sizes, T, (5501 + s * 0x9e3779b1) | 0, !o.copy, o.rebuy, m.rc.fundSteps);
      const p$ = pct$(path.profitPct);
      pay += p$; netY += p$ - path.rebuys * m.rc.cost;
      if (goal > 0 && p$ >= goal) hit++;
      down += path.allDown; reb += path.rebuys; alive += path.aliveEnd;
    }
    if (s < SIMS) return false;
    cur.push({ n, base, sizes, pGoal: hit / SIMS, payYear: pay / SIMS, netYear: netY / SIMS, pAllDown: down / SIMS, rebuys: reb / SIMS, aliveEnd: alive / SIMS });
    s = 0; hit = pay = netY = down = reb = alive = 0;
    if (++bi >= bases.length) { out.push(cur); cur = []; bi = 0; n++; }
    return n > o.maxAccounts;
  }, () => {
    if (my !== accSeq) return;
    accCache = { key, rows: out };
    render();
  });
  return null;
}
function renderAccounts(m: FModel, goal: number, fmtNet: (pct: number) => string, div: number, perS: string) {
  const o = optSettings();
  setNum("nAcc", String(o.maxAccounts));
  $i("sAcc").value = String(o.maxAccounts);
  document.querySelectorAll<HTMLButtonElement>("button[data-acm]").forEach((b) =>
    b.setAttribute("aria-pressed", String((b.getAttribute("data-acm") === "copy") === o.copy)));
  document.querySelectorAll<HTMLButtonElement>("button[data-acs]").forEach((b) =>
    b.setAttribute("aria-pressed", String((b.getAttribute("data-acs") === "ladder") === o.ladder)));
  $i("cbRebuy").checked = o.rebuy;
  $("accAssume").innerHTML = (o.copy ? "Copy-trade: every account takes the same trades, so they lose together." : "Independent: each account trades its own stream from the same edge.") +
    (o.rebuy ? " A blown account is replaced for " + money(m.rc.cost) + (m.rc.days ? ", trading again after ~" + m.rc.days + " days" : "") + "." : " Blown accounts are not replaced.") +
    " Starting the accounts costs extra: " + money(m.rc.cost) + " each to get funded.";
  void fmtNet;
  const tbl = $("accTable");
  if (m.noEdge || m.thin) { tbl.innerHTML = '<p class="small muted">' + (m.noEdge ? "No size makes this edge pay." : "Too few trades to size.") + "</p>"; $("accRead").textContent = ""; return; }
  const all = ensurePortfolio(m, goal);
  if (!all) { tbl.innerHTML = '<span class="skel"></span><p class="small muted">simulating up to ' + o.maxAccounts + " accounts&hellip;</p>"; $("accRead").textContent = ""; return; }
  const rows = all.map((stats) => pickPerCount(stats, goal, o.survTarget)).filter((r): r is PortfolioStat => !!r);
  const rec = recommendCount(rows, goal);
  const sz = (r: PortfolioStat) => o.ladder && r.n > 1 ? r.sizes[0].toFixed(2) + "&ndash;" + r.sizes[r.sizes.length - 1].toFixed(2) + "%" : r.base.toFixed(2) + "%";
  const m$ = (v: number) => money(v / div);
  tbl.innerHTML = '<div class="scroll"><table class="breakdown"><thead><tr><th>Accounts</th><th>Size each</th>' + (goal > 0 ? "<th>Goal reached</th>" : "") +
    "<th>Payouts " + perS + "</th><th title=\"Payouts minus replacements\">Net " + perS + '</th><th title="Share of years with a moment when NO account is up - with copy-trading, the risk that matters">All down at once</th><th>Replaced / yr</th><th></th></tr></thead><tbody>' +
    rows.map((r) => '<tr' + (r === rec ? ' class="rec"' : "") + "><td>" + (r === rec ? "&#9733; " : "") + r.n + "</td><td>" + sz(r) + "</td>" +
      (goal > 0 ? "<td>" + pctEst(r.pGoal) + "</td>" : "") + "<td>" + m$(r.payYear) + "</td><td>" + m$(r.netYear) + "</td><td>" + pctEst(r.pAllDown) +
      "</td><td>" + r.rebuys.toFixed(1) + '</td><td><button type="button" class="usebtn" data-use="' + r.base.toFixed(2) + '">Use</button></td></tr>').join("") +
    "</tbody></table></div>";
  tbl.querySelectorAll<HTMLButtonElement>("button[data-use]").forEach((b) => b.addEventListener("click", () => {
    $i("srf").value = b.getAttribute("data-use") || "";
    $i("srf").dispatchEvent(new Event("input", { bubbles: true }));
  }));
  $("accRead").innerHTML = !rec ? "" : goal > 0
    ? (rec.pGoal >= 0.5
      ? "&#9733; <b>" + rec.n + " account" + (rec.n > 1 ? "s" : "") + " at " + sz(rec) + "</b> is the fewest that reaches " + money(goal / div) + perS + " in at least half the years (" + pctEst(rec.pGoal) + "), netting about " + m$(rec.netYear) + perS + "."
      : "No setup up to " + o.maxAccounts + " accounts reaches " + money(goal / div) + perS + " in half the years; the closest is <b>" + rec.n + " at " + sz(rec) + "</b> (" + pctEst(rec.pGoal) + "). Allow more accounts, or lower the goal.")
    : "&#9733; <b>" + rec.n + " account" + (rec.n > 1 ? "s" : "") + " at " + sz(rec) + "</b> nets the most (" + m$(rec.netYear) + perS + ") while every account is down at once in no more than " + Math.round((1 - o.survTarget) * 100) + "% of years.";
}

// ---------------- DECISION ----------------
//
// The eval-size curve. Three screens used to end on "lower the eval risk" with
// no number behind it, and measured against this app's own engine that advice is
// backwards wherever a clock is binding: on a 2-step firm with a 30-day limit,
// a +0.30R edge costs $379 to fund at 0.70% and $75,000 at 0.10%, because at
// 0.10% no attempt reaches the target inside the budget and the pass rate is
// zero. Same edge, same firm, 198x the money, in the direction the app was
// pointing. Where there is no time limit the old advice was right - the cheapest
// size really is the floor - which is precisely why it has to be measured per
// firm rather than asserted.
//
// Cached on the firm rules and the edge, NOT on the eval-risk slider: the curve
// is the same curve wherever the user happens to be standing on it, so dragging
// srde is a redraw and not a recompute.
interface ECache { key?: string; pts: EvalPoint[] }
let eCache: ECache = { pts: [] };
function evalCurve(): EvalPoint[] {
  const key = [F.type, F.p1, F.p2, F.maxdd, F.ddType, F.ddLock, F.daily, F.minDays, F.cons, F.tpd,
    F.timeLimit || 0, F.fee, F.feeMode, F.activation || 0, F.resetFee || 0, F.instant ? 1 : 0,
    edgeFp()].join("|");
  // a stale curve during a drag is the same bargain the funded curve strikes:
  // the 250ms settle re-runs it at full count
  if (eCache.key !== key && (!FAST || !eCache.pts.length)) {
    eCache = { key, pts: challengeCurve(riskGrid(), FAST ? 150 : 400) };
  }
  return eCache.pts;
}
// What the tab can honestly say about eval sizing, in one place, because the
// tile and the verdict paragraph must not be able to disagree.
interface EvalAdvice {
  ok: boolean;                 // is there a number to name at all
  why?: string;                // when there is not, the reason
  short?: string;              // ...and what the tile says instead of a number
  sub?: string;                // a second line under it
  tone?: string;               // the tile's class, matching the Funded tab's vocabulary
  risk?: number; cost?: number; days?: number; pass?: number;
  barMet?: boolean;            // does the named size clear the 85% bar in 9 of 10 plausible edges
  checking?: boolean;          // the robust check is still running: barMet is the point estimate's
  cheapest?: number;           // the bottom of the band, which `cost` is within 3% of
  lo?: number; hi?: number;    // the flat bottom, in risk %
  cur?: EvalPoint;             // the nearest grid point to where the user is standing
}
function evalAdvice(curRisk: number): EvalAdvice {
  if (F.instant) {
    return { ok: false, short: "no evaluation", tone: "",
      why: "There is no evaluation at this firm - the fee buys the account, so there is no eval size to choose. Size for the funded rules instead." };
  }
  // A sizing instruction derived from a record this app will not call an edge is
  // a guess wearing a number. Validate refuses below 30 resolved trades and so
  // does the Funded tab's best size; so does this. Slider edges carry no sample.
  if (S.trades && S.trades.length < PLAN_MIN_N) {
    return { ok: false, short: "too thin to size", tone: "cell-caution",
      sub: S.trades.length + " trades &middot; needs " + PLAN_MIN_N + "+",
      why: S.trades.length + " resolved trades is under the " + PLAN_MIN_N + " Validate needs before it will call an edge real, so this tab will not size an evaluation on it either. Everything else here still runs." };
  }
  const pts = evalCurve();
  if (!pts.length) return { ok: false, short: "n/a", tone: "", why: "" };
  const ep = pickEvalSize(pts);
  const pl = ep.pl;
  const best = pts[pl.pk];
  // costToFund caps a hopeless edge at 200 attempts rather than dividing by zero,
  // so a firm nobody can pass produces a FLAT curve at the cap - and a flat curve
  // has a "cheapest" point like any other. Naming it would be a sizing answer to
  // a question that is not about sizing.
  if (expectancy() <= 0 || best.pass <= 0.005) {
    return { ok: false, short: "no size passes", tone: "cell-stop",
      sub: "edge or rules, not sizing",
      why: "No eval size passes this - the best of them still needs " +
        (best.attempts >= 199 ? "many" : best.attempts.toFixed(1)) + " attempts. That is the edge or the firm's rules, not your sizing." };
  }
  // Inside the band the money is flat by construction, so naming its cheapest
  // POINT is answering a question that has no answer. What is not flat is the
  // clock: with no time limit the cost curve bottoms out at the slider floor and
  // stays there, and 0.10% reaches a funded account in ~100 trading days where
  // 0.82% costs the same $381 and takes ~13. The extra 87 days buy nothing.
  //
  // But speed alone is not safe to pick on either, and a MONTHLY firm is where
  // that shows: its cost is quantised to whole billing months, so the band runs
  // 0.30% to 2.90% at an identical $165 while the single-attempt pass rate falls
  // 98% to 58%. Equal expected cash, four times the washouts - and "the retries
  // still fit inside one billing month" is the model assumption carrying that,
  // not something a trader would sign up for.
  //
  // So: same shape as the Funded tab's best size. Flat objective, then a bar,
  // then the extreme that clears it. The bar is the 0.85 this app already calls
  // "Strong" on the Challenge tab, read here against the END-TO-END odds rather
  // than phase 1 - that is the thing being bought. If nothing in the band clears
  // it, fall back to the likeliest to land rather than the fastest. The rule
  // itself is pickEvalSize in plan.ts, called above, because the journal's My
  // firm surface names an eval size by exactly this rule against a BOUND firm.
  // Same robustness as the Funded tab's balanced size (2.18.7): "quickest size
  // that still passes 85%" leans toward the largest, most fragile size in the
  // band, and the 85% was read at the measured edge only. The bar now has to
  // hold in 9 of 10 plausible versions of the edge. Until that check lands the
  // point-estimate pick is shown, marked as still being checked.
  const evMat = ensureRobust("eval", eCache.key + "|" + pl.lo + "-" + pl.hi, pl.hi - pl.lo + 1,
    (i) => challengeCurve([pts[pl.lo + i].risk], ROBUST_EVAL_SIMS)[0].pass);
  const evShares = evMat ? sharesAt(evMat, PASS_BAR) : null;
  let pickI = ep.pick, barMet = ep.barMet;
  if (evShares) {
    let rp = -1;
    for (let i = pl.lo; i <= pl.hi; i++) {
      if (pts[i].pass < PASS_BAR || (evShares[i - pl.lo] ?? 0) < optSettings().conf) continue;
      if (rp < 0 || pts[i].days < pts[rp].days) rp = i;
    }
    if (rp >= 0) { pickI = rp; barMet = true; }
    else { barMet = false; pickI = pl.lo; for (let i = pl.lo + 1; i <= pl.hi; i++) if (pts[i].pass > pts[pickI].pass) pickI = i; }
  }
  const sel = pts[pickI];
  let ci = 0, cd = 1e9;
  pts.forEach((p, i) => { const d = Math.abs(p.risk - curRisk); if (d < cd) { cd = d; ci = i; } });
  return { ok: true, risk: sel.risk, cost: sel.cost, days: sel.days, pass: sel.pass, barMet, checking: !evShares,
    cheapest: best.cost, lo: pts[pl.lo].risk, hi: pts[pl.hi].risk, cur: pts[ci] };
}
function renderDecision() {
  const re = Number($i("srde").value), rf = Number($i("srdf").value);
  setNum("nrde", $i("srde").value); setNum("nrdf", $i("srdf").value);
  $("lrdeSub").textContent = riskSub(re); $("lrdfSub").textContent = riskSub(rf);
  const st = challengeStats(re, FAST ? 600 : 2600);
  // an instant firm's "pass" is bought, not simulated - the fee IS the cost
  const pPass = F.instant ? 1 : evalPass(st);
  const fs = fundedStats(rf, FAST ? 400 : 1400, yearSteps());
  // the same user haircut the Firms table applies - a row click lands here and
  // the two screens must quote the same dollars
  const hcD = Math.max(0, Math.min(0.5, LS.get<number>("pel_haircut", 0)));
  const payout = (((fs.profit / 100) * F.account * F.split) / 100) * (1 - hcD);
  const cf = costToFund(pPass, F.instant ? 0 : st.meanDaysAll);
  const netEV = payout - cf.cost;
  const feeNote = (F.feeMode === "monthly" ? ", ~" + cf.months + " mo of subscription" : "") +
    (F.activation ? ", +" + money(F.activation) + " activation" : "");
  $("dPass").innerHTML = F.instant ? "instant" + '<div class="sub">the fee buys the account</div>'
    : pctEst(pPass) + (F.type === "2step" ? '<div class="sub">both phases</div>' : "");
  $("dFees").innerHTML = F.instant
    ? money(cf.cost) + '<div class="sub">exact &middot; no evaluation to retry</div>'
    : money(cf.cost) + '<div class="sub">' + (cf.attempts >= 199 ? "many" : cf.attempts.toFixed(1)) + " attempts" + feeNote + "</div>";
  $("dPayout").innerHTML = money(payout) + '<div class="sub">per year' + (hcD > 0 ? ", after your " + Math.round(hcD * 100) + "% haircut" : "") + "</div>";
  // The rest of the funnel, same formulas and pairing as the Firms table
  // (scoreFirm/assemble in suggest.ts): the paid odds CONDITIONAL on funding
  // pair with the retry-inclusive cost - the end-to-end figure would charge
  // eval failure twice. Clicking a Firms row lands here; the two screens must
  // not disagree about whether money ever comes out.
  // FAST cuts the sim COUNT during a drag, never the horizon - the same tier
  // rule as every other stat on this tab; the 250ms settle re-runs at full count
  const po = payoutOdds(rf, FAST ? 200 : PAID_SIMS, yearSteps());
  const firstPay = (((po.chunkPct / 100) * F.account * F.split) / 100) * (1 - hcD);
  const evFirst = po.p * firstPay - cf.cost;
  $("dPaid").innerHTML = pctEst(pPass * po.p) + '<div class="sub">' + pctEst(po.p) + " if funded" +
    (po.medDays ? " &middot; ~" + po.medDays + "d" : "") + "</div>";
  $("dEvFirst").innerHTML = (evFirst >= 0 ? "+" : "") + money(evFirst) +
    '<div class="sub">' + money(firstPay) + " a payout</div>";
  $("dEvFirst").className = "v " + (evFirst > 0 ? "cell-go" : "cell-stop");
  // Budget to funded: quantiles of a geometric, not the mean. n_q attempts at
  // confidence q, cash from the same fee model as costToFund (resets included),
  // time = failures' mean days for the misses plus the winners' median for the
  // final pass. Whole attempts, whole months - this is a floor for planning,
  // never a forecast to two decimals.
  const bud = $("dBudget");
  if (F.instant) {
    bud.innerHTML = '<div class="tile" style="grid-column:1/-1"><div class="k">Nothing to budget</div><div class="v" style="font-size:13px;font-weight:400">Instant funding &middot; one purchase, ' +
      money(cf.cost) + ".</div></div>";
  } else if (pPass <= 0.005 || expectancy() <= 0) {
    bud.innerHTML = '<div class="tile" style="grid-column:1/-1"><div class="k">No budget to plan</div><div class="v" style="font-size:13px;font-weight:400">Pass odds too low to budget.</div></div>';
  } else {
    bud.innerHTML = [0.5, 0.8, 0.95].map((q) => {
      const nq = Math.max(1, Math.ceil(Math.log(1 - q) / Math.log(1 - pPass)));
      const days = Math.round((nq - 1) * st.meanFailDays + st.medDays);
      const months = Math.max(1, Math.round(days / TRADING_DAYS_PER_MONTH));
      // monthly = the subscription runs for the whole streak (same continuous
      // billing as costToFund); once = full price first, resets after if priced
      const cash = F.feeMode === "monthly"
        ? F.fee * Math.max(1, Math.ceil(days / TRADING_DAYS_PER_MONTH)) + (F.activation || 0)
        : F.fee + (nq - 1) * ((F.resetFee || 0) > 0 ? (F.resetFee as number) : F.fee) + (F.activation || 0);
      return '<div class="tile"><div class="k">' + Math.round(q * 100) + '% confident</div><div class="v">' + money(cash) +
        '</div><div class="ts">' + nq + " attempt" + (nq > 1 ? "s" : "") + " &middot; ~" + months + " month" + (months > 1 ? "s" : "") + "</div></div>";
    }).join("");
  }
  const dBands = ensureBands(re, rf);
  $("dEV").textContent = (netEV >= 0 ? "+" : "") + money(netEV);
  $("dEVBand").innerHTML = bandSub(dBands ? dBands.ev : null, (v) => (v >= 0 ? "+" : "") + money(v), "measuring the range&hellip;");
  $("dEV").style.color = netEV > 0 ? css("--go-ink") : css("--stop-ink");
  // WORTH IT is a verdict, and a verdict has to survive the downside of its own
  // inputs. Judged on the LOW end of the record's range, not the mean: an EV of
  // +$40,000 whose 90% range reaches -$800 is not a purchase this app should be
  // stamping "worth it". Where the band straddles zero the badge says so rather
  // than picking a side. A slider edge has no sample and keeps the old rule.
  const evLoD = dBands ? dBands.ev.lo : netEV;
  const good = evLoD > 0;
  const straddles = !!dBands && dBands.ev.lo <= 0 && dBands.ev.hi > 0;
  $("dChip").textContent = straddles ? "Could go either way" : good ? "Worth it" : "Not worth it";
  $("dChip").style.background = straddles ? css("--caution") : good ? css("--go") : css("--stop");
  $("dChip").title = dBands
    ? "Graded on the LOW end of your record's own 90% range (" + money(dBands.ev.lo) + " to " + money(dBands.ev.hi) +
      "), not on the " + money(netEV) + " mean. The mean assumes your measured edge is exactly right."
    : "Graded on the point estimate - a slider edge carries no sample, so there is no range to take the low end of.";
  // ---- the cheapest eval size, measured on this firm ----
  const ea = evalAdvice(re);
  const ev = $("dEvalSize");
  if (!ea.ok) {
    ev.innerHTML = (ea.short || "n/a") + (ea.sub ? '<div class="k">' + ea.sub + "</div>" : "");
    ev.className = "v " + (ea.tone || "");
    ev.title = ea.why || "";
  } else {
    // The cost column the recommendation has to carry: the user's OWN size,
    // priced the same way, so "best" is a comparison and not an assertion. It
    // has to be on the tile rather than only in the tooltip, because the tile is
    // COLOURED by that gap - and a red number that is the recommendation reads
    // as "this size is bad" unless the line underneath says what is red.
    const c = ea.cur as EvalPoint;
    const worse = c.cost / Math.max(1, ea.cheapest as number);
    const gap = worse <= 1.03 ? "" :
      '<div class="k">yours: ' + c.risk.toFixed(2) + "% &rarr; " + money(c.cost) + "</div>";
    // and when nothing in the band clears the 85% bar, the pass rate is the
    // thing the reader most needs and it goes on the face, not in the title
    const warn = ea.checking ? '<div class="k">checking against your edge&rsquo;s range&hellip;</div>'
      : ea.barMet ? "" : '<div class="k">' + pctEst(ea.pass as number) + " an attempt &middot; best available</div>";
    ev.innerHTML = (ea.risk as number).toFixed(2) + "%" +
      '<div class="k">' + money(ea.cost as number) + " to fund &middot; ~" + ea.days + "d</div>" + gap + warn;
    ev.className = "v " + (worse <= 1.03 ? "cell-go" : worse >= 1.5 ? "cell-stop" : "cell-caution");
    ev.title = "Expected cost to a funded account is flattest between " + (ea.lo as number).toFixed(2) + "% and " +
      (ea.hi as number).toFixed(2) + "% - every size in that band funds you for within 3% of the same money, so what separates them is the clock and the washouts, not the cash. " +
      (ea.risk as number).toFixed(2) + "% is " + (ea.barMet
        ? "the quickest of them that still passes 85+ attempts in 100 in at least 9 of 10 plausible versions of your edge"
        : "the likeliest of them to land - nothing in the band reliably clears 85 attempts in 100 (in 9 of 10 plausible versions of your edge)") +
      ": " + money(ea.cost as number) + ", about " + ea.days + " trading days, " + pctEst(ea.pass as number) +
      " per attempt. Your " + c.risk.toFixed(2) + "% costs " + money(c.cost) + " (" +
      (c.attempts >= 199 ? "many" : c.attempts.toFixed(1)) + " attempts, ~" + c.days + " days)" +
      (worse <= 1.03 ? " - already on the flat bottom." :
        c.risk < (ea.risk as number)
          ? ". Below the band a smaller size is slower, so more attempts run out of room before they reach the target: it costs MORE, not less."
          : ". Above the band the drawdown floor takes more attempts before one lands.");
  }
  const mu = expectancy();
  // The old copy ended "Lower the eval size" - an instruction, in a fixed
  // direction, with no number and no measurement behind it. The curve above
  // knows whether a different eval size would actually turn this positive, so
  // the paragraph now says which it is.
  let notWorth: string;
  if (!ea.ok) {
    notWorth = "Expected payout doesn't cover the cost to fund.";
  } else {
    const evAtBest = payout - (ea.cheapest as number);
    notWorth = evAtBest > 0
      ? "Try " + (ea.risk as number).toFixed(2) + "% eval risk: cost to fund drops to " +
        money(ea.cost as number) + ", net about " + money(payout - (ea.cost as number)) + "."
      : "Not worth it at any eval size. The edge or the firm has to change.";
  }
  $("dRead").textContent = mu <= 0
    ? "No proven edge."
    : good
      ? "Expected payout beats the cost to fund."
      : notWorth;
  $("dEdgeMsg").textContent = "No proven edge. Check Validate first.";
  $("dEdgeNote").className = mu <= 0 ? "note warn" : "note warn hide";
  renderPlans(ea);
}

// ---- Decision: plans for your goal (2.19.0) ----
// Each Funded-tab optimization paired with the robust eval size, priced for the
// first year the way this tab prices everything: payouts at that funded size,
// minus the expected cost to get funded at that eval size. Apply sets both
// sliders, so the verdict above re-reads the plan.
function renderPlans(ea: EvalAdvice) {
  const el = $("dPlans");
  const m = fundedModel();
  const goal = goalYearly().v;
  const per = goalPeriod(), div = per === "mo" ? 12 : 1, perS = per === "mo" ? "/mo" : "/yr";
  if (m.noEdge) { el.innerHTML = '<p class="small muted">No size makes this edge pay, so there is no plan to price.</p>'; $("dPlansNote").textContent = ""; return; }
  if (m.thin) { el.innerHTML = '<p class="small muted">Too few trades to size (needs ' + PLAN_MIN_N + "+).</p>"; $("dPlansNote").textContent = ""; return; }
  if (!ea.ok) { el.innerHTML = '<p class="small muted">' + (ea.why || "No eval size to plan with.") + "</p>"; $("dPlansNote").textContent = ""; return; }
  const sugs = suggestions(m, goal);
  if (m.pending || ea.checking) { el.innerHTML = '<span class="skel"></span><p class="small muted">checking every size against your edge&rsquo;s range&hellip;</p>'; $("dPlansNote").textContent = ""; return; }
  const evalR = ea.risk as number, cost = ea.cost as number;
  el.innerHTML = '<div class="scroll"><table class="breakdown"><thead><tr><th>Plan</th><th>Eval size</th><th>Funded size</th><th>Survival (1 yr)</th><th>Payouts ' + perS +
    '</th><th title="First-year payouts at the funded size, minus the expected cost to get funded at the eval size">Net, first year ' + perS + "</th><th></th></tr></thead><tbody>" +
    sugs.map((g) => {
      const netY = pct$(g.prof) - cost;
      return '<tr data-plan="' + g.key + '"><td><span class="mk" style="color:' + g.color + '"></span><b>' + g.name + '</b><div class="small muted">' + g.why + "</div></td>" +
        "<td>" + evalR.toFixed(2) + "%</td><td>" + g.r.toFixed(2) + "%</td><td>" + Math.round(g.surv * 100) + "%</td><td>" + (g.pays / div).toFixed(per === "mo" ? 1 : 0) +
        '</td><td class="' + (netY > 0 ? "cell-go" : "cell-stop") + '">' + money(netY / div) + (g.extra ? '<div class="small muted">' + g.extra + "</div>" : "") +
        '</td><td><button type="button" class="usebtn" data-apply="' + evalR.toFixed(2) + "|" + g.r.toFixed(2) + '">Apply</button></td></tr>';
    }).join("") + "</tbody></table></div>";
  el.querySelectorAll<HTMLButtonElement>("button[data-apply]").forEach((b) => b.addEventListener("click", () => {
    const [e, f] = (b.getAttribute("data-apply") || "").split("|");
    $i("srde").value = e; $i("srde").dispatchEvent(new Event("input", { bubbles: true }));
    $i("srdf").value = f; $i("srdf").dispatchEvent(new Event("input", { bubbles: true }));
  }));
  $("dPlansNote").innerHTML = "Eval size: the quickest that still passes " + Math.round(PASS_BAR * 100) + "+ attempts in 100 in " +
    Math.round(optSettings().conf * 100) + "% of plausible edges (" + money(cost) + " to fund). Funded sizes and settings are the Funded tab&rsquo;s." +
    (goal > 0 ? " Goal: " + money(goal / div) + perS + "." : "");
}

export function render() {
  if (MODE !== "sim") return;
  if (TAB === "validate") renderValidate();
  else if (TAB === "challenge") renderChallenge();
  else if (TAB === "funded") renderFunded();
  else renderDecision();
  // The rail is on every tab, and the counterfactual readout it carries depends
  // on the firm and the eval/funded risk sliders as well as on the trades - so
  // it renders here rather than only when the journal edge is re-applied, or it
  // would quote the odds of the firm that was loaded two firms ago. It caches on
  // all of those and no-ops when no cut is set.
  hooks.renderEdgeCut(FAST);
}

// ---------------- persistence ----------------
interface SimSave {
  p: string; pay: string; payMode: "rr" | "pf"; paylbl: string; paymin: string; paymax: string; paystep: string;
  sc?: string;
  n: string; disp: "$" | "%"; F: typeof F; tab: string; src: string; srf: string; srde: string; srdf: string; useJ: boolean;

}
export function saveSim() {
  LS.set("pel_sim", {
    p: swr().value, pay: spay().value, payMode: S.payMode, paylbl: $("lpaylbl").textContent || "",
    sc: $i("ssc").value,
    paymin: spay().min, paymax: spay().max, paystep: spay().step,
    n: sn().value, disp: view.DISP, F: { ...F }, tab: TAB,
    src: $i("src").value, srf: $i("srf").value, srde: $i("srde").value, srdf: $i("srdf").value,

    useJ: $i("useJournal").checked,
  } as SimSave);
}
export function restoreSim(): boolean {
  // The payout haircut's only control lived on the removed Firms tab. A value
  // the user can no longer see or change must not keep scaling every payout,
  // so it is cleared here and every reader falls back to 0.
  LS.set("pel_haircut", 0);
  // same deal for the payout goal: a personal target, not part of the scenario.
  // Only the dollar box is seeded here - renderFunded re-seats the payout slider,
  // which needs the firm's account size and split to convert.
  $i("nGoal").value = String(Math.round(goalYearly().v / goalDiv()));
  const d = LS.get<SimSave | null>("pel_sim", null);
  if (!d) return false;
  try {
    swr().value = d.p; sn().value = d.n; S.payMode = d.payMode || "rr";
    $i("ssc").value = d.sc || "0";   // pre-2.4.2 saves carry no scratch rate = 0
    if (d.paymin) { spay().min = d.paymin; $i("npay").min = d.paymin; }
    if (d.paymax) { spay().max = d.paymax; $i("npay").max = d.paymax; }
    if (d.paystep) { spay().step = d.paystep; $i("npay").step = d.paystep; }
    spay().value = d.pay;
    if (d.paylbl) $("lpaylbl").textContent = d.paylbl;
    document.querySelectorAll<HTMLButtonElement>(".seg button[data-pm]").forEach((x) =>
      x.setAttribute("aria-pressed", x.getAttribute("data-pm") === S.payMode ? "true" : "false"));
    if (d.F) setFirm({ ...PRESETS["2step"], ...d.F });
    view.DISP = d.disp || "$";
    document.querySelectorAll<HTMLButtonElement>(".seg button[data-disp]").forEach((x) =>
      x.setAttribute("aria-pressed", x.getAttribute("data-disp") === view.DISP ? "true" : "false"));
    if (d.src) $i("src").value = d.src;
    if (d.srf) $i("srf").value = d.srf;
    if (d.srde) $i("srde").value = d.srde;
    if (d.srdf) $i("srdf").value = d.srdf;
    if (d.tab && TABS.includes(d.tab)) {
      TAB = d.tab;
      document.querySelectorAll<HTMLButtonElement>(".tabs button[data-tab]").forEach((x) =>
        x.setAttribute("aria-pressed", x.getAttribute("data-tab") === TAB ? "true" : "false"));
      TABS.forEach((t) => $("p-" + t).classList.toggle("hide", t !== TAB));
    }
    return !!d.useJ;
  } catch {
    return false;
  }
}

// ---------------- theme + mode ----------------
// ---- colour schemes ----
// The palettes themselves live in index.html (one `:root[data-theme]` block
// each, with the whole token set); this table owns their NAMES, their order in
// the menu and the one-line description under each. `key: ""` is System, which
// carries no data-theme attribute at all and therefore follows the OS through
// the prefers-color-scheme block - deleting the attribute is what "follow the
// system" means here, not a third palette that guesses.
const THEMES: { key: string; name: string; desc: string }[] = [
  { key: "", name: "System", desc: "follows your OS" },
  { key: "light", name: "Daylight", desc: "the original light" },
  { key: "dark", name: "Forest", desc: "the original dark green" },
  { key: "carbon", name: "Carbon", desc: "neutral near-black" },
  { key: "midnight", name: "Midnight", desc: "cool blue dark" },
  { key: "parchment", name: "Parchment", desc: "warm light" },
];
function applyTheme(t: string) {
  const r = document.documentElement;
  // Anything not in the table - a hand-edited localStorage entry, or a palette
  // removed by a later build - falls back to System rather than stamping an
  // attribute no stylesheet answers, which would leave the app in the light
  // defaults with a dark OS and no way to tell why.
  const known = THEMES.some((x) => x.key === t && x.key !== "");
  if (known) r.dataset.theme = t; else delete r.dataset.theme;
}
function currentTheme(): string {
  return document.documentElement.dataset.theme || "";
}
function renderThemeMenu() {
  const cur = currentTheme();
  $("themeMenu").innerHTML = THEMES.map((t) =>
    '<button class="throw" role="menuitemradio" data-theme-set="' + t.key + '" aria-checked="' + (t.key === cur) + '">' +
    '<span class="sw sw-' + (t.key || "system") + '"><i class="a"></i><i class="b"></i><i class="c"></i></span>' +
    '<span class="tn"><b>' + t.name + '</b><span class="td">' + t.desc + "</span></span>" +
    '<span class="tk">&#10003;</span></button>').join("");
  $("themeMenu").querySelectorAll<HTMLButtonElement>("button[data-theme-set]").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.getAttribute("data-theme-set") || "";
      applyTheme(k);
      LS.set("pel_theme", k || "system");
      closeThemeMenu();
      // the MutationObserver below repaints every canvas when data-theme moves,
      // but picking System when nothing was set removes an attribute that was
      // already absent - no mutation, no repaint - so redraw here as well
      render();
      if (MODE === "journal") hooks.renderJournal();
    }));
}
function closeThemeMenu() {
  $("themeMenu").classList.add("hide");
  $("themeBtn").setAttribute("aria-expanded", "false");
}
export function setMode(m: string) {
  MODE = m;
  document.querySelectorAll<HTMLButtonElement>(".modenav button[data-mode]").forEach((b) =>
    b.setAttribute("aria-pressed", b.getAttribute("data-mode") === m ? "true" : "false"));
  $("mode-sim").classList.toggle("hide", m !== "sim");
  $("mode-journal").classList.toggle("hide", m !== "journal");
  if (m === "sim") render(); else hooks.renderJournal();
  LS.set("pel_mode", m);
}
export function getMode() { return MODE; }

// ---------------- wiring ----------------
export function wireSim() {
  [swr(), spay(), sn(), $i("ssc")].forEach((el) =>
    el.addEventListener("input", () => { if (S.trades) return; syncSliders(); sumStrat(); scheduleRender(); saveSim(); }));
  document.querySelectorAll<HTMLButtonElement>(".seg button[data-pm]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const nm = btn.getAttribute("data-pm") as "rr" | "pf";
      if (nm === S.payMode) return;
      const p = Number(swr().value) / 100;
      const np = $i("npay");
      // R:R and profit factor are two parameterisations of ONE quantity, so this
      // control is meant to change the units and nothing else. It used to CLAMP
      // the conversion into the target slider's range - and clamping is not a
      // display decision, it is a silent edit of the edge. At a 56% win rate a
      // 6.0 R:R is a profit factor of 7.6; the old code wrote 3.0, and clicking
      // back handed you 2.36 instead of the 6.0 you started with. The units
      // button quietly rewrote the trade being modelled, in both directions.
      //
      // Two changes. The profit-factor range now spans what the R:R control can
      // actually reach at ordinary win rates, so the conversion is lossless
      // almost everywhere; and where it still would not be, the switch is
      // REFUSED with the reason rather than performed with a different number.
      const cur = Number(spay().value);
      const conv = p > 0.001 && p < 0.999
        ? (nm === "pf" ? (p / (1 - p)) * cur : (cur * (1 - p)) / p)
        : (nm === "pf" ? 1.4 : 1);
      const lo = nm === "pf" ? 0.5 : 0.5, hi = nm === "pf" ? 8 : 6;
      if (conv < lo - 1e-9 || conv > hi + 1e-9) {
        toast("At a " + Math.round(p * 100) + "% win rate that is " +
          (nm === "pf" ? "a profit factor of " : "a reward:risk of ") + conv.toFixed(2) +
          ", outside this control's " + lo + "-" + hi + " range. Switching would change your edge rather than just its units, so it has not.");
        return;
      }
      if (nm === "pf") {
        spay().min = "0.5"; spay().max = "8"; spay().step = "0.02";
        np.min = "0.5"; np.max = "8"; np.step = "0.02";
        $("lpaylbl").textContent = "Profit factor";
      } else {
        spay().min = "0.5"; spay().max = "6"; spay().step = "0.05";
        np.min = "0.5"; np.max = "6"; np.step = "0.05";
        $("lpaylbl").textContent = "Reward to risk (R)";
      }
      spay().value = String(conv);
      S.payMode = nm;
      document.querySelectorAll<HTMLButtonElement>(".seg button[data-pm]").forEach((x) =>
        x.setAttribute("aria-pressed", x === btn ? "true" : "false"));
      if (!S.trades) syncSliders();
      sumStrat(); render(); saveSim();
    }));

  const presetSel = $s("fPreset");
  rebuildPresetSel();
  presetSel.addEventListener("change", () => {
    const v = presetSel.value;
    // "(custom)" is a display state, not a preset - there is nothing to load
    if (!v) { syncPresetSel(); return; }
    // presets carry the RULES; account size stays whatever the user set
    // (the quick-size chips / account field are the only owners of it)
    const keepAccount = F.account;
    if (v.startsWith("c:")) { const p = CUSTOM[v.slice(2)]; if (p) setFirm({ ...p, account: keepAccount }); }
    else setFirm({ ...PRESETS[v], account: keepAccount });
    firmToForm(); sumFirm(); scheduleRender(); saveSim();
  });
  $("fSavePreset").addEventListener("click", () => {
    const def = (F.type === "2step" ? "2-step" : F.type === "1phase" ? "1-phase" : "futures") + " DD" + F.maxdd + "%";
    ask('Save the current firm rules as a preset:<br><br><input id="presetName" class="numin" style="width:100%;text-align:left" value="' + esc(def) + '">', [
      { label: "Cancel", kind: "", value: false },
      { label: "Save", kind: "primary", value: true },
    ], (yes) => {
      if (!yes) return;
      const inp = document.getElementById("presetName") as HTMLInputElement | null;
      const name = (inp && inp.value.trim()) || def;
      CUSTOM[name] = { ...F, name };
      LS.set("pel_presets", CUSTOM);
      rebuildPresetSel();
      // name the preset the user just made - its rules may tie with a built-in
      // (saving straight off one is common) and the sync alone would keep the
      // built-in's name, which reads as the save having failed
      presetSel.value = "c:" + name;
      syncPresetSel();
      toast("Preset saved.");
    });
    const inp = document.getElementById("presetName") as HTMLInputElement | null;
    if (inp) { inp.focus(); inp.select(); }
  });
  $("fDelPreset").addEventListener("click", () => {
    const v = presetSel.value;
    if (!v.startsWith("c:")) return;
    const name = v.slice(2);
    ask("Delete preset <b>" + esc(name) + "</b>?", [
      { label: "Cancel", kind: "", value: false },
      { label: "Delete", kind: "danger", value: true },
    ], (yes) => {
      if (!yes) return;
      delete CUSTOM[name];
      LS.set("pel_presets", CUSTOM);
      rebuildPresetSel();
      // the deleted preset's rules are still the rules in force - the dropdown
      // parks on "(custom)" rather than falling to a built-in it did not load
      syncPresetSel();
      toast("Preset deleted.");
    });
  });
  document.querySelectorAll<HTMLButtonElement>("#accChips .opt").forEach((b) =>
    b.addEventListener("click", () => {
      F.account = Number(b.getAttribute("data-acc"));
      firmToForm(); sumFirm(); scheduleRender(); saveSim();
    }));
  fFields.forEach((id) => {
    $(id).addEventListener("input", () => { formToFirm(); sumFirm(); scheduleRender(); saveSim(); });
    $(id).addEventListener("change", () => { formToFirm(); firmToForm(); sumFirm(); scheduleRender(); saveSim(); });
  });
  $("firmToggle").addEventListener("click", () => $("firmEdit").classList.toggle("open"));
  document.querySelectorAll<HTMLButtonElement>(".seg button[data-disp]").forEach((b) =>
    b.addEventListener("click", () => {
      view.DISP = b.getAttribute("data-disp") as "$" | "%";
      document.querySelectorAll<HTMLButtonElement>(".seg button[data-disp]").forEach((x) =>
        x.setAttribute("aria-pressed", x === b ? "true" : "false"));
      sumFirm(); render(); saveSim();
    }));

  document.querySelectorAll<HTMLButtonElement>(".tabs button[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      TAB = b.getAttribute("data-tab")!;
      document.querySelectorAll<HTMLButtonElement>(".tabs button[data-tab]").forEach((x) =>
        x.setAttribute("aria-pressed", x === b ? "true" : "false"));
      TABS.forEach((t) => $("p-" + t).classList.toggle("hide", t !== TAB));
      render(); saveSim();
    }));

  ["src", "srf", "srde", "srdf"].forEach((id) => $(id).addEventListener("input", () => { scheduleRender(); saveSim(); }));
  $("reroll").addEventListener("click", () => { PATH_SEED = (Math.random() * 1e9) | 0; renderChallenge(); });
  document.querySelectorAll<HTMLButtonElement>("button[data-cphase]").forEach((b) =>
    b.addEventListener("click", () => { setChallengePhase(Number(b.getAttribute("data-cphase"))); renderChallenge(); }));
  // payout goal: its own LS key rather than the sim save, like the haircut - it
  // is a personal target, not part of the edge/firm scenario being modelled
  $i("nGoal").addEventListener("input", function () {
    if (this.value !== "" && isFinite(Number(this.value))) setGoal(Number(this.value) * goalDiv(), false);
  });
  $i("sGoal").addEventListener("input", function () { setGoal(Number(this.value) * payChunk$(), true); });
  document.querySelectorAll<HTMLButtonElement>("button[data-goalp]").forEach((b) =>
    b.addEventListener("click", () => {
      LS.set("pel_pay_goal_period", b.getAttribute("data-goalp"));
      // the stored goal is yearly and does not move - only the box it is shown in
      $i("nGoal").value = String(Math.round(goalYearly().v / goalDiv()));
      scheduleRender();
    }));
  // ---- optimizer settings (Funded) ----
  const pctIn = (id: string, key: "survTarget" | "velFloor", lo: number, hi: number) =>
    $i(id).addEventListener("change", function () {
      const v = Number(this.value);
      if (this.value !== "" && isFinite(v)) setOpt({ [key]: Math.max(lo, Math.min(hi, v)) / 100 } as Partial<ReturnType<typeof optSettings>>);
      scheduleRender();
    });
  pctIn("nSurvT", "survTarget", 50, 99);
  pctIn("nVelF", "velFloor", 30, 99);
  $s("selConf").addEventListener("change", function () { setOpt({ conf: Number(this.value) }); scheduleRender(); });
  $("optReset").addEventListener("click", () => { resetOpt(); scheduleRender(); });
  // ---- several accounts (Funded) ----
  const setAcc = (v: number) => { setOpt({ maxAccounts: Math.max(1, Math.min(10, Math.round(v))) }); scheduleRender(); };
  $i("sAcc").addEventListener("input", function () { setNum("nAcc", this.value); setAcc(Number(this.value)); });
  $i("nAcc").addEventListener("change", function () { if (this.value !== "" && isFinite(Number(this.value))) setAcc(Number(this.value)); });
  document.querySelectorAll<HTMLButtonElement>("button[data-acm]").forEach((b) =>
    b.addEventListener("click", () => { setOpt({ copy: b.getAttribute("data-acm") === "copy" }); scheduleRender(); }));
  document.querySelectorAll<HTMLButtonElement>("button[data-acs]").forEach((b) =>
    b.addEventListener("click", () => { setOpt({ ladder: b.getAttribute("data-acs") === "ladder" }); scheduleRender(); }));
  $i("cbRebuy").addEventListener("change", function () { setOpt({ rebuy: this.checked }); scheduleRender(); });
  // ---- Validate: the drawdown controls ----
  $i("nDDLim").value = String(LS.get<number>("pel_dd_limit", 0) || 0);
  $i("cbOvershoot").checked = LS.get<boolean>("pel_dd_overshoot", true);
  // The horizon is the one control on this tab whose absence was the bug, so it
  // is persisted: a trader who plans in 500-trade blocks should not have to
  // re-say so every session, and the default is derived from their own pace
  // rather than being a round number the app likes.
  wireNum("nHz", "sHz");
  $i("sHz").addEventListener("input", function () {
    setNum("nHz", this.value);
    LS.set("pel_dd_horizon", Number(this.value));
    scheduleRender();
  });
  $i("nDDLim").addEventListener("input", function () {
    LS.set("pel_dd_limit", Number(this.value) || 0);
    scheduleRender();
  });
  document.querySelectorAll<HTMLButtonElement>("button[data-ddm]").forEach((b) =>
    b.addEventListener("click", () => {
      LS.set("pel_dd_method", b.getAttribute("data-ddm"));
      render();
    }));
  $i("cbOvershoot").addEventListener("change", function () {
    LS.set("pel_dd_overshoot", this.checked);
    render();
  });

  wireNum("nwr", "swr"); wireNum("npay", "spay"); wireNum("nn", "sn"); wireNum("nsc", "ssc");
  wireNum("nrc", "src"); wireNum("nrf", "srf"); wireNum("nrde", "srde"); wireNum("nrdf", "srdf");


  document.querySelectorAll<HTMLButtonElement>(".modenav button[data-mode]").forEach((b) =>
    b.addEventListener("click", () => setMode(b.getAttribute("data-mode")!)));

  applyTheme(LS.get("pel_theme", "system"));
  $("themeBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("themeMenu");
    const open = menu.classList.contains("hide");
    if (open) { renderThemeMenu(); menu.classList.remove("hide"); }
    else menu.classList.add("hide");
    $("themeBtn").setAttribute("aria-expanded", String(open));
  });
  // click-away and Escape, so the menu is never something you have to hunt for
  // the way out of - it sits over the app, not beside it
  document.addEventListener("click", (e) => {
    if ($("themeMenu").classList.contains("hide")) return;
    if (!(e.target instanceof Node) || !$("themeWrap").contains(e.target)) closeThemeMenu();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeThemeMenu(); });
  if (window.matchMedia) {
    try {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { render(); if (MODE === "journal") hooks.renderJournal(); });
    } catch { /* older webview */ }
  }
  new MutationObserver(() => { render(); if (MODE === "journal") hooks.renderJournal(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  let rzT: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener("resize", () => {
    if (rzT) clearTimeout(rzT);
    rzT = setTimeout(() => { render(); if (MODE === "journal") hooks.renderJournal(); }, 150);
  });

  $i("useJournal").addEventListener("change", function (this: HTMLInputElement) {
    if (this.checked) hooks.applyJournalEdge(); else hooks.clearJournalEdge();
    sumStrat();   // the bar said "sliders" while the app resampled the journal
  });
}
