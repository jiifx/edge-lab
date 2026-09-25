// Journal: log, editor, detail, stats (quant layer + prop odds + edge report), export/import.
import { $, $i, $s, $c, css, fit, mulberry, localDate, esc, hasNum, LS, toast, toastAction, ask, hooks, chartTip, wireTips, pctEst } from "./util";
import { S, F, money, Firm, setFirm, withFirm, withEdge, view } from "./state";
import { computeR, computeRraw, plannedRR, hasRBasis, challengeStats, evalPass, fundedStats, payoutOdds, costToFund, wilson, profitPlateau, PAID_SIMS, PAY_CHUNK, yearSteps, TradeLike } from "./engine";
import { Store, TAURI, Trade, JMeta, b64ToBlob } from "./store";
import { bandOf, consWindows, DayR, PLATEAU_TOL } from "./plan";
import { generateSample, SAMPLE_ACCT } from "./sample";

export let JT: Trade[] = [];
export const JMETA: JMeta = { startBalance: null, accounts: ["Main"], balances: {} };
let JLOADED = false;
// account scope: "" = all accounts combined, otherwise one account name
let ACCT = LS.get<string>("pel_acct", "");
// which account feeds the simulator's "Use my journal" edge ("" = all accounts)
let EDGE_ACCT = LS.get<string>("pel_edge_acct", "");
// which segment, if any, is LEFT OUT of that edge. This is the counterfactual
// the Simulator answers - "what happens to my odds if I stop taking shorts?" -
// and it is the only filter that reaches the engine. null = nothing cut, which
// is the behaviour every build before this one had. Stored as the same JSON key
// the <select> uses and read back through cutParse, so a hand-edited or
// corrupted localStorage entry cannot put a half-formed segment into segMatch.
let EDGE_CUT: SegRef | null = cutParse(LS.get<string>("pel_edge_cut", ""));
let SELMODE = false;
const SEL = new Set<string>();

function accounts(): string[] {
  return JMETA.accounts && JMETA.accounts.length ? JMETA.accounts : ["Main"];
}
function accOf(t: Trade): string {
  return t.account || "Main";
}
function scoped(): Trade[] {
  return ACCT === "" ? JT : JT.filter((t) => accOf(t) === ACCT);
}
// migrate/normalize meta: legacy startBalance becomes Main's balance; accounts self-register from trades
function normalizeMeta() {
  if (!JMETA.accounts || !JMETA.accounts.length) JMETA.accounts = ["Main"];
  if (!JMETA.balances) JMETA.balances = {};
  if (JMETA.startBalance != null && JMETA.balances["Main"] == null) JMETA.balances["Main"] = JMETA.startBalance;
  JT.forEach((t) => { const a = accOf(t); if (JMETA.accounts!.indexOf(a) < 0) JMETA.accounts!.push(a); });
  if (ACCT !== "" && JMETA.accounts.indexOf(ACCT) < 0) ACCT = "";
}
function scopeStart(): number | null {
  const bals = JMETA.balances || {};
  if (ACCT !== "") { const b = bals[ACCT]; return b != null && isFinite(b) && b > 0 ? b : null; }
  // Combined balance is only honest when every account that TRADES has a
  // starting balance - otherwise one account's start was summed against every
  // account's P&L and the Return % compared mismatched populations.
  let sum = 0, any = false;
  const traded = new Set(JT.map((t) => accOf(t)));
  for (const a of accounts()) {
    const b = bals[a];
    if (b != null && isFinite(b) && b > 0) { sum += b; any = true; }
    else if (traded.has(a)) return null;
  }
  return any ? sum : null;
}

// ---------- the dollar basis ----------
// R is this journal's unit of record. Dollars are a DERIVED layer that only
// exists once an account says what one R is worth, and the direction is one-way:
// R -> $, never $ -> R. computeR/computeRraw/hasRBasis must never read any of
// this, or a P&L-only broker row would gain a fabricated risk basis (Trap #2).
export type RBasis = { mode: "fixed" | "pct"; v: number };
// coerce an untrusted rBasis entry (import / restore) or reject it
function sanitizeRBasis(v: unknown): RBasis | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { mode?: unknown; v?: unknown };
  const n = Number(o.v);
  if (!isFinite(n) || n <= 0) return null;
  return o.mode === "fixed" || o.mode === "pct" ? { mode: o.mode, v: n } : null;
}
// dollars per 1R on an account, or null when the account is R-only.
// Deliberately a CONSTANT: a "% of running equity" mode would make the balance
// path-dependent - every dollar figure would become an ordered walk rather than
// one multiplication, and a mis-set percentage would compound. That is a
// different feature, not a tweak to this one.
function rValue(acct: string): number | null {
  const b = (JMETA.rBasis || {})[acct];
  if (!b) return null;
  if (b.mode === "fixed") return b.v > 0 ? b.v : null;
  const start = (JMETA.balances || {})[acct];
  if (start == null || !isFinite(start) || start <= 0) return null;   // a % of nothing is not zero, it is unknown
  const d = (b.v / 100) * start;
  return d > 0 ? d : null;
}
// the R value that applies to the current journal scope. Combined view only has
// one when every account that trades agrees, for the same reason scopeStart()
// refuses to sum mismatched starts.
function scopeRValue(): number | null {
  if (ACCT !== "") return rValue(ACCT);
  let v: number | null = null;
  const traded = new Set(JT.map((t) => accOf(t)));
  for (const a of traded) {
    const r = rValue(a);
    if (r == null) return null;
    if (v == null) v = r;
    else if (Math.abs(v - r) > 0.005) return null;
  }
  return v;
}
let urlCache: Record<string, string> = {};
let EDIT_ID: string | null = null;
let DETAIL_ID: string | null = null;
interface FormImage { id: string; blob: Blob; url?: string; w?: number; h?: number; existing?: boolean }
let formImages: FormImage[] = [];
let calMonth: string | null = null;
let JVIEW = "log";
// stats sub-tab: perf | edge | cal
let STATS_TAB = LS.get<string>("pel_stats_tab", "perf");
// which side the long/short panel details: all | long | short. The COMPARISON
// under it always shows both - this only picks whose win/loss breakdown is open.
let LSIDE = LS.get<string>("pel_ls_side", "all");
// journal-wide display unit: R multiples, dollars, or both. Drives the trade
// cards, the day headers and the calendar so the whole journal reads in one unit.
type CalUnit = "R" | "$" | "both";
let JUNIT: CalUnit = LS.get<CalUnit>("pel_unit", LS.get<CalUnit>("pel_cal_unit", "R"));
function setUnit(u: CalUnit) {
  JUNIT = u;
  LS.set("pel_unit", u);
  document.querySelectorAll<HTMLButtonElement>("button[data-unit]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.getAttribute("data-unit") === u)));
  renderJournal();
}
// R / P&L / Both drives the trade log and the calendar. Performance and the
// Edge report are R-denominated by design (R is the unit of record; their
// dollar tiles are data-gated, not unit-switched), so on those two screens the
// switch changed nothing while sitting pressed in the header. A control that
// does nothing must not look live - it hides there, the same rule the
// Select/Delete tool group beside it already follows.
function syncUnitSeg() {
  const el = document.getElementById("unitSeg");
  if (el) el.style.display = dollarsOn() && (JVIEW === "log" || STATS_TAB === "cal") ? "" : "none";
}
// segment filter applied by clicking an edge-report row ({group, label} from the report)
export interface SegRef { group: string; label: string }
let SEGF: SegRef | null = null;
// entry-model filter: a set of ticked models, OR'd together (Notion-style multi-select).
// Empty set = no model filter. Not persisted, like every other filter.
const MODELF = new Set<string>();
// Which unit the MFE/MAE boxes are in: "R" or "price". Remembered, because how
// someone logs excursions is a habit, not a per-trade decision - but opening a
// trade that stored the OTHER unit switches to it, so nothing is ever displayed
// in a unit it was not written in.
let EXU = LS.get<string>("pel_ex_unit", "R");
// quick-log editor mode (hides the deep sections for fast capture)
let ED_QUICK = LS.get<boolean>("pel_ed_quick", false);
// is the dollar-basis disclosure open? Dollars are opt-in, so this starts shut;
// loadTrades opens it once for anyone who already has a balance or an R value,
// so an existing setting never goes invisible behind a new collapsed panel.
// "Show dollars" is the master switch for the whole DERIVED dollar layer, not
// just for the R-value input it used to open. It governed only that box, so a
// journal with dollars hidden still printed "Total P&L", "Balance" and the
// equity line's dollar restatement beside a button reading SHOW DOLLARS - the
// control said one thing and four surfaces did another.
//
// null = never chosen, and the layer then FOLLOWS THE DATA - re-derived every
// render, not resolved once at load. A one-shot resolve missed the journal
// that gains its first priced trade AFTER loading, which is every interactive
// session and is what multiacct.cjs caught: never hide dollars from someone
// who logs a P&L. Once the user clicks, their choice is stored and wins.
let DOLLARS_CHOICE = LS.get<boolean | null>("pel_dollars_open", null);
let DOLLARS_DATA = false;
function refreshDollarData() {
  DOLLARS_DATA = !!(Object.keys(JMETA.rBasis || {}).length ||
    Object.values(JMETA.balances || {}).some((b) => b != null && isFinite(b) && b > 0) ||
    JT.some((t) => hasNum(t.pnl)));
}
function dollarsOn(): boolean {
  return DOLLARS_CHOICE !== null ? DOLLARS_CHOICE : DOLLARS_DATA;
}
// One predicate for every dollar surface. BOTH gates matter and they are not
// the same question: the priced count is "can this record be priced at all"
// (the 2.6.0 data gate - never re-gate THAT on the R/$/Both unit switch, which
// broke multiacct.cjs), and dollarsOn() is "does the user want to see it".
function showDollars(pricedCount: number): boolean {
  return dollarsOn() && pricedCount > 0;
}
// The unit actually in force. With dollars hidden the trade log and calendar
// print R, because a journal that hides money should not print money - but the
// stored JUNIT is untouched, so turning dollars back on restores what the user
// picked rather than resetting them to R.
function unitNow(): CalUnit {
  return dollarsOn() ? JUNIT : "R";
}

// the firm whose rules apply to the current journal scope: the account's bound
// firm when one exists, otherwise whatever the Simulator is set to
function firmFor(): { firm: Firm; bound: boolean } {
  const af = JMETA.accountFirms || {};
  if (ACCT !== "" && af[ACCT]) return { firm: af[ACCT], bound: true };
  return { firm: F, bound: false };
}
// which phase the bound account is in; absent = eval, which every pre-2.4
// binding was - the migration IS the default
function phaseFor(acct: string): { phase: "eval" | "funded"; since?: string } {
  const ap = JMETA.accountPhase || {};
  return ap[acct] || { phase: "eval" };
}
function setPhase(acct: string, phase: "eval" | "funded") {
  JMETA.accountPhase = JMETA.accountPhase || {};
  const prev = JMETA.accountPhase[acct] || { phase: "eval" as const };
  // fundedSince starts the payout-window clock the first time the account is
  // marked funded; flipping back to eval clears it so a re-fund restarts clean
  JMETA.accountPhase[acct] = phase === "funded"
    ? { phase, since: prev.phase === "funded" && prev.since ? prev.since : todayKey() }
    : { phase };
  saveMeta();
  renderJournal();
}

function firmShort(f: Firm): string {
  return (f.name ? f.name + " " : "") + money(f.account) + " " +
    (f.type === "2step" ? "2-step" : f.type === "1phase" ? "1-phase" : "futures");
}

const QUALITY = ["A+ setup", "B setup", "C setup", "Forced", "Revenge trade"];
const MISTAKES = ["Entered early", "Entered late", "Sized too large", "No stop", "Moved stop", "Exited early", "Held too long", "Outside plan", "Chased", "Overtraded"];
const CONDITIONS = ["Trend day", "Range / chop", "High volatility", "Low volume", "News day", "Open drive", "Reversal"];
// The session vocabulary, matching the form's select. Session is REQUIRED on a
// new trade, so an untagged one can now only be a row logged before that rule or
// imported from a CSV that carried no session column. Those fall in with Other -
// which is what the option already means: a session outside the three majors, or
// one nobody recorded. A "(none)" bucket beside "Other" split the same idea in
// two and read like a fault in the journal rather than a gap in the data. The
// session map counts how many were folded in, so the merge is never silent.
const SESSIONS = ["Asia", "London", "New York", "Other"];
function sessionOf(t: Trade): string { return t.session || "Other"; }
const INSTRUMENTS: Record<string, string[]> = {
  "Futures": ["ES", "MES", "NQ", "MNQ", "YM", "MYM", "RTY", "M2K", "CL", "MCL", "GC", "MGC", "SI", "NG"],
  "Indices CFD": ["US500", "US100", "US30", "GER40", "UK100", "JPN225", "AUS200", "EU50"],
  "Metals": ["XAUUSD", "XAGUSD", "XPTUSD"],
  "Forex": ["EURUSD", "GBPUSD", "USDJPY", "USDCAD", "AUDUSD", "NZDUSD", "USDCHF", "EURGBP", "GBPJPY", "EURJPY"],
  "Crypto": ["BTCUSD", "ETHUSD"],
};

function saveMeta() {
  if (TAURI) { if (JLOADED) Store.persistAll(JT, JMETA); }
  else LS.set("pel_jmeta", JMETA);
}
// full-size object URLs, used by the detail gallery and lightbox (original quality)
function imgURL(id: string, blob: Blob): string {
  if (urlCache[id]) return urlCache[id];
  const u = URL.createObjectURL(blob);
  urlCache[id] = u;
  return u;
}

// ---------- list thumbnails ----------
// Card thumbs are 64x48. Decoding a full 1600px screenshot for each one is what
// made long logs expensive, so the first sighting of an image renders a small
// copy, caches it, and releases the full-size blob URL. Originals are untouched
// on disk - detail view and lightbox still load them at full resolution.
const thumbCache: Record<string, string> = {};
const thumbWaiting: Record<string, ((u: string | null) => void)[]> = {};
const THUMB_PX = 192;
function getThumb(id: string, cb: (url: string | null) => void) {
  const hit = thumbCache[id];
  if (hit) { cb(hit); return; }
  if (thumbWaiting[id]) { thumbWaiting[id].push(cb); return; }
  thumbWaiting[id] = [cb];
  const done = (u: string | null) => {
    const qs = thumbWaiting[id] || [];
    delete thumbWaiting[id];
    if (u) thumbCache[id] = u;
    qs.forEach((f) => f(u));
  };
  Store.getImage(id, (rec) => {
    if (!rec || !rec.blob) { done(null); return; }
    const src = URL.createObjectURL(rec.blob);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || THUMB_PX, h = img.naturalHeight || THUMB_PX;
      const sc = Math.min(1, THUMB_PX / Math.max(w, h, 1));
      const cw = Math.max(1, Math.round(w * sc)), ch = Math.max(1, Math.round(h * sc));
      const c = document.createElement("canvas");
      c.width = cw; c.height = ch;
      try { c.getContext("2d")!.drawImage(img, 0, 0, cw, ch); } catch { /* tainted */ }
      c.toBlob((b) => {
        URL.revokeObjectURL(src);   // the full-size blob is no longer pinned by the list
        done(b ? URL.createObjectURL(b) : null);
      }, "image/jpeg", 0.8);
    };
    img.onerror = () => { URL.revokeObjectURL(src); done(null); };
    img.src = src;
  });
}
// only fetch a thumb once its card is near the viewport
let thumbObs: IntersectionObserver | null = null;
function observeThumbs(root: HTMLElement) {
  if (thumbObs) thumbObs.disconnect();
  if (!("IntersectionObserver" in window)) {
    root.querySelectorAll<HTMLImageElement>("img[data-thumb]").forEach((im) =>
      getThumb(im.getAttribute("data-thumb")!, (u) => { if (u) im.src = u; }));
    return;
  }
  thumbObs = new IntersectionObserver((entries, obs) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      const im = e.target as HTMLImageElement;
      obs.unobserve(im);
      getThumb(im.getAttribute("data-thumb")!, (u) => { if (u) im.src = u; });
    });
  }, { rootMargin: "400px 0px" });
  root.querySelectorAll<HTMLImageElement>("img[data-thumb]").forEach((im) => thumbObs!.observe(im));
}
function downscale(file: Blob, cb: (b: Blob, w: number, h: number) => void) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    const mx = 1600, w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const sc = Math.min(1, mx / Math.max(w, h, 1));
    const cw = Math.max(1, Math.round(w * sc)), ch = Math.max(1, Math.round(h * sc));
    const c = document.createElement("canvas");
    c.width = cw; c.height = ch;
    try { c.getContext("2d")!.drawImage(img, 0, 0, cw, ch); } catch { /* tainted - keep original */ }
    c.toBlob((b) => { URL.revokeObjectURL(url); cb(b || file, cw, ch); }, "image/jpeg", 0.85);
  };
  img.onerror = () => { URL.revokeObjectURL(url); cb(file, 0, 0); };
  img.src = url;
}
export function tradeR(t: Trade): number {
  const r = t._R != null ? t._R : computeR(t as TradeLike);
  return isFinite(r) ? r : 0;
}
function isResolved(t: Trade): boolean {
  return hasNum(t.pnl) || hasNum(t.exit) || (t.Rmanual && hasNum(t.R));
}
// Trades that can carry a real R. isResolved alone is not enough: a trade logged
// with only a P&L has no risk basis, and computeRraw would hand back a fabricated
// +/-1. Those still count for dollars and for the edge report - they are simply
// excluded from anything that treats R as a measurement.
export function resolvedRs(list: Trade[]): number[] {
  return list.filter((t) => isResolved(t) && hasRBasis(t)).map(tradeR).filter((r) => isFinite(r));
}
// how many resolved trades had to be dropped for lacking a risk basis
export function noRBasisCount(list: Trade[]): number {
  return list.filter((t) => isResolved(t) && !hasRBasis(t)).length;
}
// explains the gap between "trades logged" and "trades measurable in R"
function noRNote(list: Trade[]): string {
  const n = noRBasisCount(list);
  return n ? " &mdash; " + n + " excluded for having no Risk $ or stop (or an R past &plusmn;1000), so their R cannot be measured" : "";
}

// ---------- filters ----------
// The entry-model bucket key. Untagged trades key on "" rather than a printable
// sentinel, so a model literally typed as "(none)" can never collide with them.
function modelOf(t: Trade): string { return (t.entryModel || "").trim(); }
const NO_MODEL_LBL = "(no model)";
function modelLbl(k: string): string { return k === "" ? NO_MODEL_LBL : k; }
// every entry model in the current account scope, most-used first then alphabetical
function modelKeys(): string[] {
  const n: Record<string, number> = {};
  scoped().forEach((t) => { const k = modelOf(t); n[k] = (n[k] || 0) + 1; });
  return Object.keys(n).sort((a, b) => (n[b] - n[a]) || a.localeCompare(b));
}
interface Filter { text: string; setup: string; outcome: string; dir: string; sess: string; mistake: string; cond: string; sym: string; from: string; to: string }
function activeFilter(): Filter {
  return {
    text: ($i("fltText").value || "").trim().toLowerCase(),
    setup: $s("fltSetup").value, outcome: $s("fltOutcome").value, dir: $s("fltDir").value,
    sess: $s("fltSess").value,
    mistake: $s("fltMistake").value, cond: $s("fltCond").value,
    sym: ($i("fltSym").value || "").trim().toLowerCase(), from: $i("fltFrom").value, to: $i("fltTo").value,
  };
}
function passFilter(t: Trade, f: Filter): boolean {
  if (f.setup && t.setup !== f.setup) return false;
  if (MODELF.size && !MODELF.has(modelOf(t))) return false;
  if (f.dir && t.direction !== f.dir) return false;
  // sessionOf, not t.session, so filtering to Other also catches the untagged
  // rows the reports fold in there - the filter and the reports must agree
  if (f.sess && sessionOf(t) !== f.sess) return false;
  if (f.sym && (t.instrument || "").toLowerCase().indexOf(f.sym) < 0) return false;
  if (f.mistake && !(t.tags && (t.tags.mistake || []).indexOf(f.mistake) >= 0)) return false;
  if (f.cond && !(t.tags && (t.tags.condition || []).indexOf(f.cond) >= 0)) return false;
  if (f.text) {
    const hay = ((t.notes || "") + " " + (t.planText || "") + " " + (t.setup || "") + " " + (t.entryModel || "") + " " + (t.instrument || "")).toLowerCase();
    if (hay.indexOf(f.text) < 0) return false;
  }
  const r = tradeR(t);
  if (f.outcome === "win" && !(r > 0.0001)) return false;
  if (f.outcome === "loss" && !(r < -0.0001)) return false;
  if (f.outcome === "flat" && (!isResolved(t) || Math.abs(r) > 0.0001)) return false;
  const day = (t.dateTime || "").slice(0, 10);
  if (f.from && day < f.from) return false;
  if (f.to && day > f.to) return false;
  return true;
}
// predicate behind each edge-report segment, reused when a report row is clicked
function segMatch(t: Trade, group: string, label: string): boolean {
  switch (group) {
    case "Regime": return !!t.tags && (t.tags.condition || []).indexOf(label) >= 0;
    case "Grade": return !!t.tags && t.tags.quality === label;
    case "Session": return sessionOf(t) === label;
    case "Entry model": return modelOf(t) === (label === NO_MODEL_LBL ? "" : label);
    case "Direction": return t.direction === label.toLowerCase();
    case "Instrument": return t.instrument === label;
    case "Emotion": return label.indexOf("Calm") === 0 ? t.emotionBefore >= 1 && t.emotionBefore <= 2 : t.emotionBefore >= 4;
    case "Discipline":
      if (label === "Followed plan") return !!t.followedPlan;
      if (label === "Broke plan") return t.followedPlan === false;
      return !t.tags || !(t.tags.mistake || []).length; // Clean (no mistakes)
    case "Mistake": return !!t.tags && (t.tags.mistake || []).indexOf(label) >= 0;
    default: return true;
  }
}
// how many filter controls are doing something, shown on the collapsed header
function fltCount(): number {
  let n = MODELF.size + (SEGF ? 1 : 0);
  ["fltText", "fltSetup", "fltOutcome", "fltDir", "fltSess", "fltMistake", "fltCond", "fltSym", "fltFrom", "fltTo"].forEach((id) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el && el.value.trim() !== "") n++;
  });
  return n;
}
function filtered(): Trade[] {
  const c = document.getElementById("fltCount");
  if (c) { const k = fltCount(); c.textContent = k ? k + " on" : ""; }
  const f = activeFilter();
  let list = scoped().filter((t) => passFilter(t, f));
  if (SEGF) list = list.filter((t) => segMatch(t, SEGF!.group, SEGF!.label));
  return list;
}
function clearSeg() { SEGF = null; }

// ---------- durations & excursions ----------
function durationMin(t: Trade): number | null {
  if (!t.dateTime || !t.exitTime) return null;
  const a = new Date(t.dateTime).getTime(), b = new Date(t.exitTime).getTime();
  if (!isFinite(a) || !isFinite(b) || b <= a) return null;
  return (b - a) / 60000;
}
export function fmtDur(min: number): string {
  // round to whole minutes FIRST, then split: rounding h and m independently
  // printed "1h 60m" for anything within 30s below a whole hour
  const tot = Math.round(min);
  if (tot < 60) return tot + "m";
  if (tot < 60 * 24) { const h = (tot / 60) | 0, m = tot % 60; return h + "h" + (m ? " " + m + "m" : ""); }
  return (min / 1440).toFixed(1) + "d";
}
// What one R is worth in money ON THIS TRADE: the risk it was actually taken
// with, else the account's standing R value. Same resolution order as trade$,
// so a dollar excursion and a dollar P&L are always divided by the same unit.
export function riskPerR(t: Trade): number | null {
  if (hasNum(t.riskAmt) && Number(t.riskAmt) > 0) return Number(t.riskAmt);
  const rv = rValue(accOf(t));
  return rv != null && rv > 0 ? rv : null;
}
// The trade's excursions in R. Three ways in, one way out:
//   1. mfeR / maeR typed directly, for a journal kept in R with no prices at all
//      - the whole point of an R-first record is that it never has to name a
//      price, and requiring one locked those traders out of Exit management.
//   2. mfeD / maeD as MONEY, divided by what 1R is worth on the trade.
//   3. mfe / mae as PRICES, converted against the entry-to-stop distance.
// Resolution runs in that order: a typed R is a statement, money needs one
// divisor, a price needs two reference points. mae* is heat, so a magnitude -
// someone typing -0.6 for "0.6R against me" means the same thing.
export function excursions(t: Trade): { mfeR: number | null; maeR: number | null } {
  const out: { mfeR: number | null; maeR: number | null } = { mfeR: null, maeR: null };
  if (hasNum(t.mfeR)) out.mfeR = Number(t.mfeR);
  if (hasNum(t.maeR)) out.maeR = Math.abs(Number(t.maeR));
  if (out.mfeR != null && out.maeR != null) return out;
  if (hasNum(t.mfeD) || hasNum(t.maeD)) {
    const rv = riskPerR(t);
    if (rv != null) {
      if (out.mfeR == null && hasNum(t.mfeD)) out.mfeR = Number(t.mfeD) / rv;
      if (out.maeR == null && hasNum(t.maeD)) out.maeR = Math.abs(Number(t.maeD)) / rv;
    }
  }
  if (out.mfeR != null && out.maeR != null) return out;
  if (!hasNum(t.entry) || !hasNum(t.stop)) return out;
  const e = Number(t.entry), per = Math.abs(e - Number(t.stop));
  if (per <= 0) return out;
  const dir = t.direction === "short" ? -1 : 1;
  if (out.mfeR == null && hasNum(t.mfe)) out.mfeR = ((Number(t.mfe) - e) / per) * dir;
  if (out.maeR == null && hasNum(t.mae)) out.maeR = ((e - Number(t.mae)) / per) * dir; // positive = how far price went against
  return out;
}

// ---------- stats primitives ----------
// The one place a trade turns into dollars. Logged P&L wins (autoPnl already
// nets fees out of it); then the trade's own Risk $; then the account's R value.
// null means "this account has no dollar basis" - every caller must render "--"
// and never substitute 0, which is exactly the bug this function exists to end:
// 58 of 72 R-only trades were being summed as $0 into a headline Balance.
export function trade$(t: Trade): number | null {
  if (hasNum(t.pnl)) return Number(t.pnl);
  const fees = hasNum(t.fees) ? Number(t.fees) : 0;
  if (hasNum(t.riskAmt) && Number(t.riskAmt) > 0) return tradeR(t) * Number(t.riskAmt) - fees;
  const rv = rValue(accOf(t));
  // an R value only prices a trade whose R is a MEASUREMENT. Without this gate
  // the sign-guess +/-1R from a P&L-only row would come back as +/- one whole
  // risk unit of fabricated money.
  if (rv != null && hasRBasis(t)) return tradeR(t) * rv - fees;
  return null;
}
// TWO POPULATIONS LIVE IN HERE, AND THEY ARE NOT THE SAME SIZE.
//
// `wins` / `losses` / `wr` count every RESOLVED trade, because the sign of a
// P&L-only broker row is real data - a dollar win is a win. `pf` / `avgWin` /
// `avgLoss` / `sumR` / `exp` run only over trades that carry a real RISK BASIS,
// because their MAGNITUDE is not data without one (Trap #2). Both contracts are
// right on their own and both are deliberate.
//
// What was wrong is combining them. `rwins` / `rlosses` / `wrR` are the win
// counts over the R-basis population, and they now exist because statsDeep was
// computing Kelly as `wr - (1 - wr) / (avgWin / avgLoss)` - a win rate from one
// population divided into a payoff ratio from the other. On a fully-priced
// journal the two coincide and nothing shows; on a record with P&L-only rows
// Kelly was quietly wrong. Anything that MIXES a rate with a payoff must use the
// R-basis pair; anything reporting how the record went keeps the resolved one.
interface Stats { n: number; rn: number; wins: number; losses: number; rwins: number; rlosses: number; scr: number; wr: number; wrR: number; pf: number; exp: number; sumR: number; sum$: number; d$n: number; d$logged: number; avgWin: number; avgLoss: number; best: number; worst: number }
export function stats(all: Trade[]): Stats {
  // an open trade is not a 0R scratch - counting it dilutes win rate and
  // expectancy, and put the Expectancy marker off the centre of its own CI band
  // (statsDeep already filters, so the two disagreed)
  const list = all.filter(isResolved);
  let n = list.length, rn = 0, rwins = 0, rlosses = 0, wins = 0, losses = 0, sumR = 0, sumWinR = 0, sumLossR = 0, sumD = 0, best = -1e9, worst = 1e9;
  let d$n = 0, d$logged = 0;
  list.forEach((t) => {
    const r = tradeR(t);
    // dollars come from ONE resolver so the tiles, the calendar and the rule
    // guard cannot disagree. d$n/d$logged carry the provenance: a dollar total
    // built from a subset of the trades has to say so.
    const d = trade$(t);
    if (d != null) { sumD += d; d$n++; if (hasNum(t.pnl)) d$logged++; }
    // the SIGN of a P&L-only trade is real data - a dollar win is a win - so
    // win/loss/scratch counts run over every resolved trade
    if (r > 0.0001) wins++; else if (r < -0.0001) losses++;
    // the MAGNITUDE is only data when the trade carries a risk basis. A trade
    // logged with just a P&L (every broker-CSV row) gets a fabricated sign(pnl)
    // R of exactly +/-1 from computeRraw - fine for colouring the row, poison
    // for expectancy, Kelly, SQN and every other R-denominated statistic, which
    // is exactly the contract stated above resolvedRs(). The quant layer now
    // honours it too, not just the odds panel.
    if (!hasRBasis(t)) return;
    rn++;
    sumR += r;
    if (r > 0.0001) { rwins++; sumWinR += r; } else if (r < -0.0001) { rlosses++; sumLossR += Math.abs(r); }
    if (r > best) best = r;
    if (r < worst) worst = r;
  });
  // Win rate is wins over DECIDED trades. A 0R scratch is neither a win nor a
  // loss, and it was silently the latter: wins/n dragged a 5W-3L-2S record down
  // to 50% when the decided record is 62.5%.
  const scr = n - wins - losses;
  const decided = wins + losses;
  const wr = decided ? wins / decided : 0, pf = sumLossR > 0 ? sumWinR / sumLossR : sumWinR > 0 ? 99 : 0, exp = rn ? sumR / rn : 0;
  // the same rate over the R-BASIS decided population, for anything that has to
  // combine it with a payoff ratio measured on that population - see the note on
  // the Stats interface
  const rdecided = rwins + rlosses;
  const wrR = rdecided ? rwins / rdecided : 0;
  return { n, rn, wins, losses, rwins, rlosses, scr, wr, wrR, pf, exp, sumR, sum$: sumD, d$n, d$logged, avgWin: rwins ? sumWinR / rwins : 0, avgLoss: rlosses ? sumLossR / rlosses : 0, best: rn ? best : 0, worst: rn ? worst : 0 };
}
interface Deep {
  n: number; exp: number; sd: number; sqn: number; sqn100: number; expLo: number; expHi: number; wrLo: number; wrHi: number;
  mdd: number; curDD: number; maxW: number; maxL: number; kelly: number | null; share: number | null;
  recent: number; recN: number; rs: number[]; tail: number | null;
}
export function statsDeep(list: Trade[]): Deep {
  // createdAt breaks same-minute ties - dateTime has minute resolution, and a
  // stable sort of the DESC-ordered journal array reversed entry order inside a
  // minute, flipping streaks and drawdown paths for rapid-fire trades
  const res = list.filter(isResolved).slice().sort((a, b) =>
    (a.dateTime || "").localeCompare(b.dateTime || "") || ((a.createdAt || 0) - (b.createdAt || 0)));
  // same contract as stats(): R is a measurement only where a risk basis exists,
  // so the equity curve, drawdown, SQN, histogram and rolling window skip the
  // sign-guess trades rather than treating a $20 loss as a full -1R
  const resR = res.filter(hasRBasis);
  const rs = resR.map(tradeR).filter((r) => isFinite(r));
  const n = rs.length, st = stats(res);
  const mean = st.exp;
  let v = 0;
  rs.forEach((r) => { v += (r - mean) * (r - mean); });
  const sd = n > 1 ? Math.sqrt(v / (n - 1)) : 0, se = n > 0 && sd > 0 ? sd / Math.sqrt(n) : 0;
  const sqn = sd > 0 ? (Math.sqrt(n) * mean) / sd : 0;
  // Tharp's quality ladder is calibrated for sqrt(min(n,100)) - graded on the
  // uncapped sqrt(n) the label rewarded journal LENGTH, not quality: the same
  // 0.05R edge walked from "weak" to "good" purely by logging 2500 trades
  const sqn100 = sd > 0 ? (Math.sqrt(Math.min(n, 100)) * mean) / sd : 0;
  // the win-rate CI runs over DECIDED trades (wins+losses), matching the rate
  // itself - a scratch carries no information about the win:loss coin
  const nd = st.wins + st.losses;
  // one Wilson implementation for the whole app (engine.ts) - the Simulator's
  // Validate tab reads the same function, so the two screens cannot print
  // different bands for the same trades again
  const wrCI = nd ? wilson(st.wr, nd) : { lo: 0, hi: 0 };
  const wrLo = wrCI.lo, wrHi = wrCI.hi;
  let cum = 0, peak = 0, mdd = 0, cw = 0, cl = 0, mw = 0, ml = 0;
  rs.forEach((r) => {
    cum += r;
    if (cum > peak) peak = cum;
    const d = peak - cum;
    if (d > mdd) mdd = d;
    if (r > 0.0001) { cw++; cl = 0; if (cw > mw) mw = cw; }
    else if (r < -0.0001) { cl++; cw = 0; if (cl > ml) ml = cl; }
  });
  const b = st.avgLoss > 0 ? st.avgWin / st.avgLoss : 0;
  // With wr defined over decided trades this is the EXACT three-outcome Kelly:
  // scratches contribute nothing to log growth, so the optimum depends only on
  // the win:loss odds and the payoff ratio. The old wins/n version treated
  // every scratch as a full loss and understated f*.
  //
  // wrR, NOT wr. `b` is measured over the R-basis population; pairing it with a
  // rate counted over the wider resolved population divides one population's odds
  // into another's payoff. The two coincide on a fully-priced journal, which is
  // why this survived - but on a record carrying P&L-only rows it produced an f*
  // for a trader who does not exist. See the note on the Stats interface.
  const kelly = b > 0 ? st.wrR - (1 - st.wrR) / b : null;
  const byDay: Record<string, number> = {};
  let totR = 0;
  resR.forEach((t) => { const d = (t.dateTime || "").slice(0, 10); const r = tradeR(t); byDay[d] = (byDay[d] || 0) + r; totR += r; });
  let maxDay = 0;
  Object.keys(byDay).forEach((k) => { if (byDay[k] > maxDay) maxDay = byDay[k]; });
  const share = totR > 0.5 && maxDay > 0 ? maxDay / totR : null;
  const rec = rs.slice(-20);
  let rm = 0;
  rec.forEach((r) => { rm += r; });
  rm = rec.length ? rm / rec.length : 0;
  return { n, exp: mean, sd, sqn, sqn100, expLo: mean - 1.96 * se, expHi: mean + 1.96 * se, wrLo, wrHi, mdd, curDD: peak - cum, maxW: mw, maxL: ml, kelly, share, recent: rm, recN: rec.length, rs, tail: st.avgLoss > 0 ? Math.abs(st.worst) / st.avgLoss : null };
}
function sqnLabel(q: number): string {
  return q >= 5 ? "superb" : q >= 3 ? "excellent" : q >= 2.5 ? "good" : q >= 2 ? "average" : q >= 1.6 ? "below avg" : "weak";
}

// ---------- prop odds (Rust engine in Tauri; TS fallback in browser) ----------
// The odds run against the account's bound firm when one exists (see firmFor),
// so an eval account is always judged by its own rules, not the sim's.
interface OddsView { pass: number; surv: number; paid: number; pay: number; fees: number; feesDetail: string; att: number; instant: boolean; funded: boolean; passLo: number; passHi: number; survLo: number; survHi: number; n: number; re: number; rf: number; grade: string; bound: boolean; firmDesc: string }
let oddsCache: { key: string; val: OddsView } | null = null;
let oddsPendingKey: string | null = null;
function firmKey(f: Firm): string {
  // instant flips the whole pass leg, so it must bust the cache like any rule
  // every rule that can move the odds has to be in here, or the cached result
  // survives a change the user just made and the panel lies about the new firm
  return "" + f.type + f.account + f.p1 + f.p2 + f.maxdd + f.ddType + f.ddLock + f.daily + f.minDays + f.cons + f.tpd + f.split + f.fee +
    "|" + (f.timeLimit || 0) + (f.feeMode || "once") + (f.activation || 0) +
    // the first-payout gate moves the "reach a payout" odds, so a change to it
    // has to invalidate the cache like any other rule - the 2.8.0 payout gates
    // (buffer/cap/winning days) move BOTH legs and belong here for the same reason
    "|" + (f.payoutFirst || 0) + "/" + (f.payoutMin || 0) + "/" + (f.resetFee || 0) + (f.instant ? "|I" : "") +
    "|" + (f.payoutBuffer || 0) + "/" + (f.payoutCap || 0) + "/" + (f.payoutCapAmt || 0) + "/" + (f.payoutCons || 0) + "/" + (f.winDays || 0) + "/" + (f.winAmt || 0);
}
function oddsKey(rs: number[], re: number, rf: number, f: Firm): string {
  let sum = 0;
  rs.forEach((r) => { sum += r; });
  // the phase is in the key because finishOdds folds it into the view: without
  // it, marking the account funded served the cached eval forecast until some
  // other input happened to change
  return ACCT + "|" + phaseFor(ACCT).phase + "|" + rs.length + "|" + sum.toFixed(3) + "|" + re + "|" + rf + "|" + firmKey(f);
}
function finishOdds(key: string, f: Firm, bound: boolean, pass: number, surv: number, profitPct: number, paid: number, meanDaysAll: number, passLo: number, passHi: number, survLo: number, survHi: number, rs: number[], re: number, rf: number) {
  // An instant-funded firm has no evaluation: the engines still simulated the
  // stand-in target as a pass gate here, so the panel showed "Pass the eval 33%"
  // for a firm where the fee simply BUYS the account. Certainty in, exact cost out.
  if (f.instant) { pass = 1; passLo = 1; passHi = 1; meanDaysAll = 0; }
  // An account MARKED FUNDED has the same shape: its evaluation is history, not
  // a forecast. The panel used to keep quoting "Pass the eval 62% - Attempts to
  // fund 1.6 - Fees to fund $540" for an account whose user had already passed
  // and already paid, one panel below the rule guard that said "(funded)".
  const funded = bound && ACCT !== "" && phaseFor(ACCT).phase === "funded";
  if (funded) { pass = 1; passLo = 1; passHi = 1; meanDaysAll = 0; }
  // ONE cost model for the whole app. This tile used to price funding as a flat
  // fee/pass while the Decision tab and Firms table charged monthly resubs and
  // the activation fee via costToFund - the same firm quoted two different
  // dollars in two rooms, understated here by up to ~58% on subscription firms,
  // and the gap even flipped the "Payout if funded" verdict colour optimistic.
  const cf = withFirm(f, () => costToFund(pass, meanDaysAll));
  const attTxt = cf.attempts >= 99 ? "many" : cf.attempts.toFixed(1);
  const val: OddsView = {
    pass, surv, paid,
    pay: ((profitPct / 100) * f.account * f.split) / 100,
    fees: cf.cost,
    feesDetail: funded ? "already spent &mdash; the account is funded"
      : (f.feeMode === "monthly"
        ? money(f.fee) + "/mo &times; ~" + cf.months + "mo of subscription (" + attTxt + " attempts)"
        : (f.resetFee || 0) > 0 && cf.attempts > 1
          ? money(f.fee) + " + " + (cf.attempts - 1).toFixed(1) + " resets &times; " + money(f.resetFee as number)
          : money(f.fee) + " &times; " + attTxt + " attempts") +
        (f.activation ? " + " + money(f.activation) + " activation" : ""),
    att: pass > 0.005 ? 1 / pass : 99,
    instant: !!f.instant,
    funded,
    passLo, passHi, survLo, survHi,
    n: rs.length, re, rf,
    grade: rs.length >= 100 ? "solid" : rs.length >= 50 ? "decent" : rs.length >= 25 ? "thin" : "very thin",
    bound, firmDesc: firmShort(f),
  };
  oddsCache = { key, val };
  oddsPendingKey = null;
  renderSummary();
  if (JVIEW === "stats" && hooks.getMode() === "journal") renderPropOdds();
}
function computeOddsTS(rs: number[], key: string, re: number, rf: number, f: Firm, bound: boolean) {
  const keepT = S.trades, keepP = S.p, keepN = S.n;
  const keepF: Firm = { ...F };
  const wins = rs.filter((r) => r > 0).length;
  S.trades = rs; S.p = wins / rs.length; S.n = rs.length;
  setFirm(f); // engine reads the global F; restored below
  try {
    const st = challengeStats(re, 2600), pPass = evalPass(st, f);
    const fs = fundedStats(rf, 1200, yearSteps());
    // PAID_SIMS, not a count of this function's own choosing: the Firms tab shows
    // the same quantity for the same firm and the two must not disagree
    const po = payoutOdds(rf, PAID_SIMS, yearSteps());
    const B = 24, passes: number[] = [], survs: number[] = [];
    for (let bI = 0; bI < B; bI++) {
      const rnd = mulberry(4242 + bI);
      const samp = new Array<number>(rs.length);
      let w2 = 0;
      for (let j = 0; j < rs.length; j++) { samp[j] = rs[(rnd() * rs.length) | 0]; if (samp[j] > 0) w2++; }
      S.trades = samp; S.p = w2 / samp.length;
      const st2 = challengeStats(re, 500);
      passes.push(evalPass(st2, f));
      survs.push(fundedStats(rf, 300, yearSteps()).surv);
    }
    passes.sort((a, b) => a - b); survs.sort((a, b) => a - b);
    finishOdds(key, f, bound, pPass, fs.surv, fs.profit, po.p, st.meanDaysAll, passes[1], passes[B - 2], survs[1], survs[B - 2], rs, re, rf);
  } finally {
    S.trades = keepT; S.p = keepP; S.n = keepN;
    setFirm(keepF);
  }
}
function ensureOdds(): OddsView | null {
  const rs = resolvedRs(scoped());
  if (rs.length < 10) return null;
  const re = Number($i("src").value), rf = Number($i("srf").value);
  const ff = firmFor();
  const key = oddsKey(rs, re, rf, ff.firm);
  if (oddsCache && oddsCache.key === key) return oddsCache.val;
  if (oddsPendingKey === key) return null;
  oddsPendingKey = key;
  if (TAURI) {
    TAURI("engine_odds", { rs, firm: ff.firm, re, rf })
      .then((o) => {
        const r = o as { pass: number; surv: number; profit_pct: number; paid: number; mean_days_all: number; pass_lo: number; pass_hi: number; surv_lo: number; surv_hi: number };
        finishOdds(key, ff.firm, ff.bound, r.pass, r.surv, r.profit_pct, r.paid, r.mean_days_all, r.pass_lo, r.pass_hi, r.surv_lo, r.surv_hi, rs, re, rf);
      })
      .catch(() => { oddsPendingKey = null; });
  } else {
    setTimeout(() => { if (oddsPendingKey === key) computeOddsTS(rs, key, re, rf, ff.firm, ff.bound); }, 0);
  }
  return null;
}

// ---------- summary ----------
// What the dollar layer can currently say about the journal scope. A balance is
// only a balance when EVERY resolved trade in scope carries dollars: one built
// from the 14 of 72 trades that happened to have a P&L is the defect this whole
// feature exists to remove, not a partial answer worth printing.
interface Money { start: number | null; sum: number; bal: number | null; ret: number | null; n: number; priced: number; logged: number; unpriced: number; full: boolean }
function scopeMoney(): Money {
  const st = stats(scoped());
  const start = scopeStart();
  const unpriced = st.n - st.d$n;
  const full = st.n > 0 && unpriced === 0;
  const bal = full && start != null ? start + st.sum$ : null;
  return {
    start, sum: st.sum$, bal, ret: bal != null && start ? (st.sum$ / start) * 100 : null,
    n: st.n, priced: st.d$n, logged: st.d$logged, unpriced, full,
  };
}
function renderSummary() {
  const st = stats(filtered());
  const tiles: [string, string | number][] = [
    ["Trades", st.n], ["Win rate", Math.round(st.wr * 100) + "%"],
    ["Expectancy", (st.exp >= 0 ? "+" : "") + st.exp.toFixed(2) + "R"],
    ["Profit factor", st.pf >= 99 ? "high" : st.pf.toFixed(2)],
    ["Total R", (st.sumR >= 0 ? "+" : "") + st.sumR.toFixed(1)],
  ];
  // The dollar layer is gated on DATA, not on the unit switch: a journal kept
  // purely in R has no dollar tiles at all until it is given an R value, while
  // one that logs a P&L on every trade is unaffected. A partly-priced scope
  // names the gap rather than printing a total that reads as the whole record.
  if (showDollars(st.d$n)) {
    const fn = st.n - st.d$n;
    tiles.push(["Total P&L", fn === 0 ? money(st.sum$) : '<span class="unset">' + fn + " of " + st.n + " unpriced</span>"]);
    const m = scopeMoney();
    if (m.bal != null && m.ret != null) {
      tiles.push(["Balance", money(m.bal)]);
      tiles.push(["Return", (m.ret >= 0 ? "+" : "") + m.ret.toFixed(1) + "%"]);
    } else if (m.start != null) {
      tiles.push(["Balance", '<span class="unset">' + m.unpriced + " of " + m.n + " unpriced</span>"]);
    }
  }
  renderEquityPanel();
  // prop odds only in prop-firm mode (and only then is the Monte Carlo worth running)
  const oc = view.PROP ? ensureOdds() : null;
  let basis = "";
  if (oc) {
    tiles.push(["Pass odds", Math.round(oc.pass * 100) + "%"]);
    tiles.push(["Pass &rarr; paid", Math.round(oc.pass * oc.paid * 100) + "%"]);
    tiles.push(["Stay funded", Math.round(oc.surv * 100) + "%"]);
    basis = '<div class="tile" style="grid-column:1/-1"><div class="k">Odds basis</div><div class="v" style="font-size:11px;font-weight:400;line-height:1.5">vs ' + esc(oc.firmDesc) +
      (oc.bound ? " (bound)" : " (Simulator firm)") +
      " &middot; eval " + oc.re.toFixed(2) + "% &middot; funded " + oc.rf.toFixed(2) + "%</div></div>";
  }
  $("jSummary").innerHTML = tiles.map((t) => '<div class="tile"><div class="k">' + t[0] + '</div><div class="v">' + t[1] + "</div></div>").join("") + basis;
}

// The sidebar equity panel. R is the headline in every mode because it is the
// unit every trade actually carries; the dollar basis sits behind a disclosure
// and only speaks once it has been given something to work with.
function renderEquityPanel() {
  const dq = statsDeep(scoped());
  const cur = dq.rs.reduce((a, b) => a + b, 0);
  const peak = cur + dq.curDD;
  const sgn = (v: number) => (v >= 0 ? "+" : "");
  let eq = dq.n
    ? "Equity <b>" + sgn(cur) + cur.toFixed(1) + "R</b> &middot; peak " + sgn(peak) + peak.toFixed(1) + "R &middot; " +
      (dq.curDD > 0.05 ? "&minus;" + dq.curDD.toFixed(1) + "R off it" : "at the high")
    : "Equity <b>0.0R</b> &mdash; no measurable trades in this scope yet.";
  const m = scopeMoney();
  // the dollar restatement of the headline is part of the dollar layer, so it
  // goes with it - this line was the loudest contradiction of the button
  if (dollarsOn() && m.bal != null && m.ret != null) {
    eq += '<span class="sub">= ' + money(m.bal) + " on a " + money(m.start!) + " start &middot; " + sgn(m.ret) + m.ret.toFixed(1) + "%</span>";
  }
  $("jEqLine").innerHTML = eq;

  $("jDollarBox").classList.toggle("hide", !dollarsOn());
  const btn = $("jDollarBtn");
  btn.textContent = dollarsOn() ? "Hide dollars" : "Show dollars";
  btn.setAttribute("aria-expanded", String(dollarsOn()));
  if (!dollarsOn()) return;

  const rv = ACCT === "" ? scopeRValue() : rValue(ACCT);
  let line: string;
  if (ACCT === "") {
    line = m.start == null
      ? "Pick one account to set its balance and R value."
      : rv == null
        ? "Accounts price 1R differently &mdash; no combined R value."
        : "1R = " + money(rv) + " across every trading account.";
  } else if (rv == null) {
    line = m.unpriced > 0
      ? "<b>" + m.unpriced + " of " + m.n + "</b> trades unpriced. Set what 1R is worth."
      : "Set what 1R is worth to price trades you log in R only.";
  } else {
    line = "1R = <b>" + money(rv) + "</b> &middot; " + m.priced + " of " + m.n + " trades priced" +
      (m.logged ? " &middot; " + m.logged + " from logged P&amp;L" : "") +
      (m.unpriced ? ' &middot; <span class="cell-stop">' + m.unpriced + " with no R basis, still unpriced</span>" : "");
  }

  $("jBalLine").innerHTML = line;
}

// ---------- rule guard: live proximity to the bound firm's rules ----------
function todayKey(): string {
  const d = new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}
function rgMeter(k: string, v: string, frac: number, invert: boolean, remaining = false): string {
  // frac = share of the limit consumed (0 safe .. 1 breached). A `remaining`
  // meter draws what is LEFT instead - full green when safe, shrinking toward
  // the limit - because its label reads "$x left" and an empty bar beside
  // "$17,200 left" read as an account on its floor.
  const f = Math.max(0, Math.min(1, frac));
  const col = (invert ? 1 - f : f) >= 0.8 ? "var(--stop)" : (invert ? 1 - f : f) >= 0.5 ? "var(--caution)" : "var(--go)";
  const w = remaining ? 1 - f : f;
  return '<div class="rg-row"><div class="rl"><span class="k">' + k + '</span><span class="v">' + v + "</span></div>" +
    '<div class="meter"><i style="width:' + Math.round(w * 100) + "%;background:" + col + '"></i></div></div>';
}
function renderRuleGuard() {
  const bar = $("ruleGuard");
  if (ACCT === "") {
    // Combined scope has no single firm to guard against - but VANISHING hid
    // the whole feature in the default scope, which is exactly where a new
    // user looks. Name the feature and the way in, instead of not existing.
    bar.classList.remove("hide");
    $("rgTitle").textContent = "Rule guard";
    $("rgBind").classList.add("hide");
    $("rgUnbind").classList.add("hide");
    $("rgPhaseSeg").classList.add("hide");
    $("rgBody").innerHTML = '<p class="small muted" style="margin:0">Pick a single account to use.</p>';
    return;
  }
  bar.classList.remove("hide");
  const af = JMETA.accountFirms || {};
  const bound = af[ACCT] || null;
  const ph = phaseFor(ACCT);
  $("rgTitle").textContent = "Rule guard" + (bound ? " - " + firmShort(bound) + (ph.phase === "funded" ? " (funded)" : "") : "");
  $("rgBind").classList.remove("hide");
  $("rgBind").textContent = bound ? "Rebind sim firm" : "Bind sim firm";
  $("rgUnbind").classList.toggle("hide", !bound);
  $("rgPhaseSeg").classList.toggle("hide", !bound);
  $("rgPhaseEval").setAttribute("aria-pressed", String(ph.phase !== "funded"));
  $("rgPhaseFunded").setAttribute("aria-pressed", String(ph.phase === "funded"));
  const body = $("rgBody");
  const acctTrades = scoped().filter(isResolved).slice().sort((a, b) =>
    (a.dateTime || "").localeCompare(b.dateTime || "") || ((a.createdAt || 0) - (b.createdAt || 0)));
  let html = "";

  // Every rule this panel measures is denominated in dollars, so an account with
  // no dollar basis has nothing to measure. Drawing the meters anyway off cum = 0
  // reports near-full headroom on an account that may be sitting on its floor -
  // the exact opposite of what the panel is for.
  const priceable = acctTrades.filter((t) => trade$(t) != null).length;
  const noBasis = priceable === 0 && acctTrades.length > 0;
  if (!bound) {
    // THE PRECONDITION, SAID OUT LOUD.
    //
    // Every meter below reads as live account state - "$2,000 left", "$1,250 left
    // today" - and that is only true if THIS journal account is the prop account.
    // The app supports one account per prop account precisely so it can be, but
    // nothing ever said so, and on a general record (one account holding
    // everything you have ever traded) the panel reports confident dollar
    // distances for an account that does not exist. Worse, the dollars come from
    // trade$ at this account's R value, so they are sizes those trades were never
    // taken at. Naming the assumption is the fix; the app cannot check it.
    html += '<p class="small muted" style="margin:0">Not bound. Click <b>Bind sim firm</b>.</p>';
  } else if (noBasis) {
    html += '<div class="note warn rg-note"><p class="h">No dollar basis</p>' +
      "<p style=\"margin:0\">Set <b>what 1R is worth</b> in the Equity panel.</p></div>";
  } else {
    // limits are % of the firm's account size, in dollars
    const acct$ = bound.account;
    const lim = (pct: number) => (pct / 100) * acct$;
    let cum = 0, peak = 0, peakEod = 0;
    const byDay: Record<string, number> = {};
    let missing = 0;
    const days: string[] = [];
    let curDay = "";
    // A FUNDED account starts fresh at the firm: its balance, peak and drawdown
    // floor begin at zero on funding day, so every meter series ignores the
    // eval-phase trades logged in the same journal account. Without this cut
    // the eval profit read as funded cushion and DD headroom was overstated.
    const guardTrades = ph.phase === "funded" && ph.since
      ? acctTrades.filter((t) => (t.dateTime || "").slice(0, 10) >= (ph.since as string))
      : acctTrades;
    // ...AND THE REBASE REOPENED THE HOLE THE noBasis BRANCH EXISTS TO CLOSE.
    //
    // `priceable` above counts the WHOLE account, so a journal full of priced
    // eval trades passes that gate - but if none of them fall on or after the
    // funding date, the series these meters are built from is empty. cum = 0
    // then reads as "no drawdown yet" and DD headroom prints the full limit: a
    // pristine account, drawn from nothing, in the one panel whose whole job is
    // saying how close you are to breaching. Same failure, same reason, a
    // different door - so the same refusal.
    const guardPriced = guardTrades.filter((t) => trade$(t) != null).length;
    if (guardPriced === 0) {
      html += '<div class="note warn rg-note"><p class="h">No trades since funding</p>' +
        "<p style=\"margin:0\">Funded" + (ph.since ? " on <b>" + esc(ph.since) + "</b>" : "") +
        ". Log a trade, or switch back to <b>eval</b>.</p></div>";
      body.innerHTML = html;
      return;
    }
    guardTrades.forEach((t) => {
      const d$ = trade$(t);
      if (d$ == null) { missing++; return; }
      const d = (t.dateTime || "").slice(0, 10);
      // an EOD threshold ratchets on the closed balance of each finished day, so
      // the previous day's final cumulative P&L is what can raise the floor
      if (curDay && d !== curDay && cum > peakEod) peakEod = cum;
      curDay = d;
      cum += d$;
      if (cum > peak) peak = cum;
      if (days.indexOf(d) < 0) days.push(d);
      byDay[d] = (byDay[d] || 0) + d$;
    });
    if (cum > peakEod) peakEod = cum;   // today's close, once the day is done
    const today = byDay[todayKey()] || 0;
    // drawdown floor mirrors the engine's ddFloor(): static from the start, or
    // trailing from the peak tick / the peak daily close, locked at break-even
    // when ddLock is set
    const dd$ = lim(bound.maxdd);
    const floor$ = bound.ddType === "static"
      ? -dd$
      : (() => {
        const base = bound.ddType === "trailing-eod" ? peakEod : peak;
        return bound.ddLock ? Math.min(base - dd$, 0) : base - dd$;
      })();
    const headroom = cum - floor$;
    html += rgMeter("DD headroom", money(headroom) + " left", 1 - headroom / lim(bound.maxdd), false, true);
    if (bound.daily > 0) {
      const dLim = lim(bound.daily);
      const used = Math.max(0, -today);
      html += rgMeter("Daily loss", money(dLim - used) + " left today", used / dLim, false, true);
    }
    if (ph.phase === "funded") {
      // A funded account has no target to pass - the questions are "when may I
      // withdraw" and "how far is the first withdrawal". Both meters track the
      // bound firm's own rules; where the firm sets no minimum, the modelled 5%
      // sweep chunk stands in and the label says so.
      // the series above is already rebased at ph.since, so these ARE the
      // funded-phase day count and profit
      const sinceDays = days.length;
      const cumSince = cum;
      const waitD = bound.payoutFirst || 0;
      if (waitD > 0) {
        html += rgMeter("Payout window", sinceDays >= waitD ? "open (" + sinceDays + "d funded)" : sinceDays + " of " + waitD + " trading days", sinceDays / waitD, true);
      } else {
        html += rgMeter("Payout window", "open from day one", 1, true);
      }
      const bar$ = Math.max((5 / 100) * acct$, bound.payoutMin || 0);
      const barLbl = (bound.payoutMin || 0) >= (5 / 100) * acct$ ? "firm minimum" : "modelled 5% sweep";
      html += rgMeter("To 1st payout", cumSince >= bar$ ? money(cumSince) + " banked - clear of the " + barLbl : money(bar$ - cumSince) + " to go (" + barLbl + ")", cumSince / bar$, true);
      if (ph.since) html += '<p class="small muted" style="margin:6px 0 0">Funded since ' + esc(ph.since) + " &mdash; window and profit measured from there.</p>";
    } else {
      html += rgMeter("Target " + (bound.type === "2step" ? "(phase)" : ""), money(Math.max(0, lim(bound.p1) - cum)) + " to go", cum / lim(bound.p1), true);
      if (bound.minDays > 0) html += rgMeter("Trading days", days.length + " of " + bound.minDays, days.length / bound.minDays, true);
      if ((bound.timeLimit || 0) > 0) {
        // the clock that fails you: colour runs the danger direction as it fills
        html += rgMeter("Time limit", days.length + " of " + bound.timeLimit + " days used", days.length / (bound.timeLimit || 1), false);
      }
      if (bound.cons > 0 && cum > 0) {
        let best = 0;
        Object.keys(byDay).forEach((k) => { if (byDay[k] > best) best = byDay[k]; });
        const share = best / cum;
        html += rgMeter("Best-day share", Math.round(share * 100) + "% (cap " + bound.cons + "%)", share / (bound.cons / 100), false);
      }
    }
    // A skipped trade does not make a meter merely incomplete, it makes it
    // OPTIMISTIC: the loss it carried never reached the floor calculation, so
    // headroom reads high on the one panel whose whole job is to stop you
    // breaching. That belongs in a warning box, not a muted footnote.
    if (missing) {
      html += '<div class="note warn rg-note"><p class="h">' + missing + " of " + guardTrades.length + " trades are not in these meters</p>" +
        "<p style=\"margin:0\">Meters are optimistic. Set <b>what 1R is worth</b> in Equity.</p></div>";
    }

  }

  // day guard: your own tilt data, watching today (works with or without a bound firm)
  const todays = acctTrades.filter((t) => (t.dateTime || "").slice(0, 10) === todayKey());
  if (todays.length) {
    let losses = 0, streak = 0, emoSum = 0, emoN = 0, net = 0, netN = 0, netR = 0;
    todays.forEach((t) => {
      const r = tradeR(t);
      netR += r;
      const d$ = trade$(t);
      if (d$ != null) { net += d$; netN++; }
      if (r < -0.0001) { losses++; streak++; } else if (r > 0.0001) streak = 0;
      const emo = t.emotionAfter || t.emotionBefore || 0;
      if (emo > 0) { emoSum += emo; emoN++; }
    });
    const avgEmo = emoN ? emoSum / emoN : 0;
    const tilted = streak >= 2 || losses >= 3 || avgEmo >= 4;
    // "+$0" on a day with no dollar basis reads as a flat session - it is the
    // same silent zero as the old Balance tile, on the line watching for tilt.
    // Report the day in R when dollars are not available for it.
    const dayTxt = netN === todays.length
      ? (net >= 0 ? "+" : "") + money(net)
      : (netR >= 0 ? "+" : "") + netR.toFixed(1) + "R";
    html += '<div class="rg-row" style="margin-top:12px"><div class="rl"><span class="k">Today</span><span class="v">' + todays.length + " trades &middot; " + dayTxt + "</span></div></div>";
    if (tilted) {
      html += '<div class="note warn" style="margin:8px 0 0;padding:9px 12px;font-size:12.5px"><p class="h">Day guard</p><p style="margin:0">' +
        (streak >= 2 ? streak + " losses in a row" : losses >= 3 ? losses + " losses today" : "logged emotion is elevated") +
        " &mdash; step away for today.</p></div>";
    }
  }

  body.innerHTML = html || '<p class="small muted" style="margin:0">No resolved trades in this account yet.</p>';
}
function bindFirm() {
  if (ACCT === "") return;
  JMETA.accountFirms = JMETA.accountFirms || {};
  JMETA.accountFirms[ACCT] = { ...F };
  saveMeta();
  oddsCache = null; // odds now run against the bound firm
  renderJournal();
  toast(firmShort(F) + " rules bound to “" + ACCT + "”.");
}
function unbindFirm() {
  if (ACCT === "" || !JMETA.accountFirms || !JMETA.accountFirms[ACCT]) return;
  delete JMETA.accountFirms[ACCT];
  // the phase goes with the binding. It used to survive - the eval/funded
  // control hides with the firm, so "funded" became a state the account sat in
  // with no way to see it and no control to leave it, and rebinding any firm
  // came back silently funded.
  if (JMETA.accountPhase) delete JMETA.accountPhase[ACCT];
  saveMeta();
  oddsCache = null;
  renderJournal();
  toast("Firm unbound - odds follow the Simulator again.");
}

// ---------- log ----------
function fmtTime(dt: string): string {
  if (!dt) return "";
  const i = dt.indexOf("T");
  return i > 0 ? dt.slice(i + 1, i + 6) : "";
}
function dayLabel(d: string): string {
  const dt = new Date(d + "T00:00:00");
  if (isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
// one trade's headline number in the journal's current unit
function pillTxt(t: Trade, r: number): string {
  const rTxt = (r >= 0 ? "+" : "") + r.toFixed(2) + "R";
  const U = unitNow();
  if (U === "R") return rTxt;
  const d = trade$(t);
  const dTxt = d == null ? "--" : money(d);
  if (U === "$") return dTxt;
  return rTxt + '<span class="sub2">' + dTxt + "</span>";
}
function tradeCard(t: Trade): string {
  const r = tradeR(t), cls = r > 0.0001 ? "win" : r < -0.0001 ? "loss" : "";
  const nImg = (t.imageIds || []).length;
  const thumb = nImg
    ? '<div class="thumbwrap"><img class="thumb" data-thumb="' + esc(t.imageIds[0]) + '" alt="">' + (nImg > 1 ? '<span class="imgn">' + nImg + "</span>" : "") + "</div>"
    : '<div class="thumb empty">no img</div>';
  let tags = "";
  if (ACCT === "" && accounts().length > 1) tags += '<span class="tag acct">' + esc(accOf(t)) + "</span>";
  if (modelOf(t)) tags += '<span class="tag em">' + esc(modelOf(t)) + "</span>";
  if (t.tags) {
    if (t.tags.quality) tags += '<span class="tag q">' + esc(t.tags.quality) + "</span>";
    (t.tags.mistake || []).slice(0, 2).forEach((m) => { tags += '<span class="tag m">' + esc(m) + "</span>"; });
    (t.tags.condition || []).slice(0, 2).forEach((c) => { tags += '<span class="tag">' + esc(c) + "</span>"; });
  }
  const box = SELMODE ? '<input type="checkbox" class="selbox" data-sel="' + esc(t.id) + '"' + (SEL.has(t.id) ? " checked" : "") + ' aria-label="Select trade">' : "";
  return '<div class="tradecard' + (SELMODE ? " selmode" : "") + (SEL.has(t.id) ? " checked" : "") + '" data-id="' + esc(t.id) + '" role="button" tabindex="0">' + box + thumb +
    '<div class="meta"><div class="top"><span class="sym">' + esc(t.instrument || "?") + "</span>" +
    '<span class="dir ' + esc(t.direction || "") + '">' + esc(t.direction || "") + "</span>" +
    '<span class="when">' + esc(fmtTime(t.dateTime)) + (durationMin(t) != null ? " &middot; " + fmtDur(durationMin(t)!) : "") + (t.setup ? " &middot; " + esc(t.setup) : "") + "</span></div>" +
    (tags ? '<div class="tags">' + tags + "</div>" : "") + "</div>" +
    '<div class="rpill ' + cls + '">' + pillTxt(t, r) + "</div></div>";
}
function segChipHtml(): string {
  if (!SEGF) return "";
  const shown = filtered().length, res = filtered().filter(isResolved).length;
  const gap = shown !== res ? " &middot; " + res + " resolved of " + shown : "";
  return '<div class="segchip">Filtered: ' + esc(SEGF.group) + " &middot; " + esc(SEGF.label) + gap + '<button type="button" id="segClear" title="Remove this filter" aria-label="Remove segment filter">&times;</button></div>';
}
function wireSegChip(el: HTMLElement) {
  el.querySelector("#segClear")?.addEventListener("click", () => { clearSeg(); renderJournal(); });
}
// log density and which days are folded. A day the user has not touched opens
// by recency: on a long journal only the latest LOG_OPEN_DAYS start open.
let LOG_DENSE = LS.get<boolean>("pel_log_dense", false);
const DAY_OPEN = new Map<string, boolean>();
let LOG_SHOWN = new Set<string>();        // ids actually drawn in the log right now
const LOG_OPEN_DAYS = 15;
function renderLog() {
  const list = filtered(), el = $("jv-log");
  LOG_SHOWN = new Set<string>();
  // recount now as well as after drawing: the empty-log paths below return
  // early, and a selection the filter just hid must not stay armed on them
  if (SELMODE) updateSelUI();
  el.classList.toggle("compact", LOG_DENSE);
  document.querySelectorAll<HTMLButtonElement>("button[data-dens]").forEach((b) =>
    b.setAttribute("aria-pressed", String((b.getAttribute("data-dens") === "compact") === LOG_DENSE)));
  if (!JT.length) {
    el.innerHTML = '<div class="empty-state"><h3>Your journal is empty</h3><p>Log a trade, import a backup or a CSV, or look around with 1,000 sample trades first.</p><p style="margin-top:14px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap"><button class="btn primary" id="emptyNew">+ Log a trade</button><button class="btn" id="emptyImport">Import</button><button class="btn" id="emptySample">Load sample journal</button></p></div>';
    document.getElementById("emptyNew")?.addEventListener("click", () => openEditor(null));
    document.getElementById("emptyImport")?.addEventListener("click", () => $i("jImportFile").click());
    document.getElementById("emptySample")?.addEventListener("click", loadSample);
    return;
  }
  if (!list.length) {
    // a fresh account is empty, not filtered - saying "loosen the filters" when
    // none are set sends you hunting through a blank filter panel
    const f = activeFilter();
    // every field passFilter reads has to be in this list - f.sess was missing,
    // so a session-only filter with no matches read "this account has no trades
    // yet", which is a data-loss message for what is actually a filter
    const anyFilter = !!(SEGF || MODELF.size || f.text || f.setup || f.outcome || f.dir || f.sess || f.mistake || f.cond || f.sym || f.from || f.to);
    el.innerHTML = segChipHtml() + (anyFilter
      ? '<div class="empty-state"><h3>No trades match</h3><p>Loosen the filters on the left.</p></div>'
      : '<div class="empty-state"><h3>No trades in ' + esc(ACCT || "this account") + '</h3><p>This account has no trades yet. Log one, or switch account scope on the left.</p><p style="margin-top:14px"><button class="btn primary" id="emptyNew2">+ Log a trade</button></p></div>');
    document.getElementById("emptyNew2")?.addEventListener("click", () => openEditor(null));
    wireSegChip(el);
    return;
  }
  let html = segChipHtml(), curDay: string | null = null, dayList: Trade[] = [];
  const nDays = new Set(list.map((t) => (t.dateTime || "").slice(0, 10) || "unknown")).size;
  let dayIdx = 0;
  const flushDay = () => {
    if (curDay == null) return;
    const ds = stats(dayList);
    // trade$'s contract: unpriceable is `--`, never a silent $0. The day header
    // was the one surface that broke it - money(ds.sum$) printed "$0" over a
    // day of R-only losses (coloured green by sumR beside it), and a day with
    // half its trades priced quoted the priced half as the whole day. A partial
    // total has to name its gap, the same way the tiles and the rule guard do.
    const dayMoney = ds.d$n === 0 ? "--"
      : ds.d$n < ds.n ? money(ds.sum$) + ' <span class="muted">· ' + (ds.n - ds.d$n) + " unpriced</span>"
        : money(ds.sum$);
    const U = unitNow();
    const dayTxt = U === "$" ? dayMoney
      : U === "R" ? (ds.sumR >= 0 ? "+" : "") + ds.sumR.toFixed(2) + "R"
        : (ds.sumR >= 0 ? "+" : "") + ds.sumR.toFixed(2) + "R  &middot;  " + dayMoney;
    const open = DAY_OPEN.has(curDay) ? DAY_OPEN.get(curDay)! : (nDays <= 2 * LOG_OPEN_DAYS || dayIdx < LOG_OPEN_DAYS);
    dayIdx++;
    html += '<div class="dayhead' + (open ? "" : " shut") + '" data-day="' + esc(curDay) + '" role="button" tabindex="0" aria-expanded="' + open + '"><span class="dl">' + esc(dayLabel(curDay)) + " &middot; " + dayList.length + " trade" + (dayList.length > 1 ? "s" : "") + '</span><span class="dr ' + (ds.sumR > 0.0001 ? "cell-go" : ds.sumR < -0.0001 ? "cell-stop" : "") + '">' + dayTxt + "</span></div>";
    // a folded day's cards are not built at all - that is most of the cost of a
    // long log; they render the moment the day is opened
    if (open) dayList.forEach((t) => LOG_SHOWN.add(t.id));
    html += '<div class="daygrp' + (open ? "" : " shut") + '">' + (open ? dayList.map(tradeCard).join("") : "") + "</div>";
  };
  list.forEach((t) => {
    const d = (t.dateTime || "").slice(0, 10) || "unknown";
    if (d !== curDay) { flushDay(); curDay = d; dayList = []; }
    dayList.push(t);
  });
  flushDay();
  el.innerHTML = html;
  // the Delete button counts the DRAWN selection, so it recounts after every
  // render - a filter change or a folded day can hide ticked rows
  if (SELMODE) updateSelUI();
  wireSegChip(el);
  el.querySelectorAll<HTMLElement>(".dayhead[data-day]").forEach((h) => {
    const flip = () => { DAY_OPEN.set(h.getAttribute("data-day")!, h.classList.contains("shut")); renderLog(); };
    h.addEventListener("click", flip);
    h.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } });
  });
  const setChecked = (c: HTMLElement, id: string, on: boolean) => {
    if (on) SEL.add(id); else SEL.delete(id);
    c.classList.toggle("checked", on);
    const box = c.querySelector<HTMLInputElement>(".selbox");
    if (box) box.checked = on;
    updateSelUI();
  };
  el.querySelectorAll<HTMLElement>(".tradecard").forEach((c) => {
    const id = c.getAttribute("data-id")!;
    c.addEventListener("click", (e) => {
      if (!SELMODE) { openDetail(id); return; }
      const tgt = e.target as HTMLElement;
      // clicking the checkbox itself already flipped it natively - mirror its state, don't re-toggle
      if (tgt && tgt.classList && tgt.classList.contains("selbox")) setChecked(c, id, (tgt as HTMLInputElement).checked);
      else setChecked(c, id, !SEL.has(id));
    });
    c.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (SELMODE) setChecked(c, id, !SEL.has(id)); else openDetail(id);
      }
    });
  });
  observeThumbs(el);
}

// ---------- stats view (sub-tabs: Performance / Edge report / Calendar) ----------
function fmtR(v: number): string { return (v >= 0 ? "+" : "") + v.toFixed(1) + "R"; }
// ---- tile + mini-meter builders for the merged metrics grid ----
function tileH(k: string, v: string, sub?: string, meterHtml?: string): string {
  return '<div class="tile"><div class="k">' + k + info(k) + '</div><div class="v">' + v + "</div>" + (sub ? '<div class="ts">' + sub + "</div>" : "") + (meterHtml || "") + "</div>";
}
// fills/bands are <i> segments; positions and widths in % of the bar.
// alpha uses opacity rather than color-mix() so the bands still render on the
// older WebKit shipped with pre-Ventura macOS.
function seg(left: number, width: number, color: string, alpha?: number): string {
  return '<i style="left:' + Math.max(0, left).toFixed(1) + "%;width:" + Math.max(0, width).toFixed(1) + "%;background:" + color +
    (alpha != null ? ";opacity:" + alpha : "") + '"></i>';
}
function tick(p: number, marker?: boolean): string {
  return '<span class="' + (marker ? "tki" : "tk") + '" style="left:' + Math.max(0, Math.min(99, p)).toFixed(1) + '%"></span>';
}
function bar(inner: string): string { return '<div class="tmeter">' + inner + "</div>"; }

// Stat definitions live in the user manual's glossary, not on the tiles.
function info(k: string): string {
  void k;
  return "";
}
// half-dial for a share-of-gross reading: green sweep = your side, red base =
// theirs, notch at the 50% break-even. Colours come from CSS classes rather than
// presentation attributes so the older WebKit on pre-Ventura macOS still themes
// them (var() in a presentation attribute is not reliable there).
const DIAL_LEN = Math.PI * 50;
function gauge(frac: number, left: string, mid: string, right: string, label: string): string {
  const f = Math.max(0, Math.min(1, frac));
  return '<svg class="gauge" viewBox="0 0 120 72" role="img" aria-label="' + esc(label) + '">' +
    '<path class="arc a-loss" d="M10 60 A50 50 0 0 1 110 60"/>' +
    '<path class="arc a-win" d="M10 60 A50 50 0 0 1 110 60" stroke-dasharray="' + (DIAL_LEN * f).toFixed(2) + " " + DIAL_LEN.toFixed(2) + '"/>' +
    '<path class="gn" d="M60 3 L60 17"/>' +
    '<text class="gt" x="6" y="70">' + left + "</text>" +
    '<text class="gt" x="60" y="70" text-anchor="middle">' + mid + "</text>" +
    '<text class="gt" x="114" y="70" text-anchor="end">' + right + "</text></svg>";
}
// win / loss / scratch as three columns. The count labels them; the height is
// the comparison. A zero column keeps a 2px stub so it reads "none", not "gone".
function wlBars(w: number, l: number, s: number): string {
  const mx = Math.max(w, l, s, 1);
  const col = (n: number, k: string, c: string) =>
    '<div class="wlc"><span class="wln">' + n + '</span><span class="wlb" style="height:' +
    Math.max(2, Math.round((n / mx) * 34)) + "px;background:" + c + '"></span><span class="wlk">' + k + "</span></div>";
  return '<div class="wlbars">' + col(w, "WIN", "var(--go)") + col(l, "LOSS", "var(--stop)") + col(s, "SCRATCH", "var(--line-strong)") + "</div>";
}
// integer scale under a 0..cap meter, with matching ticks ON the meter, so the
// bar is read against numbers instead of guessed at
function intTicks(cap: number): string {
  let out = "";
  for (let i = 1; i < cap; i++) out += tick((i / cap) * 100);
  return out;
}
function intScale(cap: number, over: boolean): string {
  let out = "";
  for (let i = 0; i <= cap; i++) out += "<span>" + i + (over && i === cap ? "+" : "") + "</span>";
  return '<div class="tscale">' + out + "</div>";
}
function heroCard(k: string, big: string, tone: string, sub: string, viz: string, read: string): string {
  return '<div class="hero"><div class="hk">' + k + info(k) + "</div>" +
    '<div class="hv' + (tone ? " " + tone : "") + '">' + big + "</div>" +
    (sub ? '<div class="hs">' + sub + "</div>" : "") +
    '<div class="hviz">' + viz + "</div></div>";
  void read;   // interpretation lives in the user manual
}
// The headline row. Nothing here is a new statistic - every number already sat
// in the tile grid below. What it adds is the scale, the reference mark and one
// sentence of plain English, which is what a tile of bare digits never gave
// anyone who does not already live in these numbers.
function renderHeroes(st: Stats, dq: Deep, deep: boolean): string {
  const has = st.rn > 0;                                   // anything R-denominated needs a risk basis
  const pay = has ? payoff(st) : null;                     // avg winner / avg loser
  const beWR = pay != null ? 1 / (1 + pay) : null;         // win rate this payoff needs to break even
  const bePay = st.wr > 0.0001 ? (1 - st.wr) / st.wr : null; // payoff this win rate needs to break even
  const cards: string[] = [];

  // --- expectancy: the number that decides whether the account grows ---
  {
    const tone = !has ? "" : st.exp > 0.0001 ? "cell-go" : st.exp < -0.0001 ? "cell-stop" : "";
    let viz = "", read: string, sub: string;
    if (!has) {
      sub = "no trade here carries a stop or risk amount";
      read = "Log an entry and stop (or a Risk $, or an R override) and this fills in.";
    } else {
      const L = Math.max(0.25, Math.abs(st.exp) * 1.6, deep ? Math.max(Math.abs(dq.expLo), Math.abs(dq.expHi)) * 1.15 : 0);
      const X = (v: number) => ((v + L) / (2 * L)) * 100;
      const band = deep ? seg(X(dq.expLo), X(dq.expHi) - X(dq.expLo),
        dq.expLo > 0 ? "var(--go)" : dq.expHi < 0 ? "var(--stop)" : "var(--caution)", 0.4) : "";
      viz = bar(band + tick(50) + tick(X(st.exp), true)) +
        '<div class="tscale"><span>&minus;' + L.toFixed(2) + "R</span><span>break-even</span><span>+" + L.toFixed(2) + "R</span></div>";
      sub = "per trade, over " + st.rn + " with a risk basis" +
        (deep ? " &middot; 95% CI " + (dq.expLo >= 0 ? "+" : "") + dq.expLo.toFixed(2) + " to " + (dq.expHi >= 0 ? "+" : "") + dq.expHi.toFixed(2) : "");
      read = st.exp > 0.0001
        ? "At this rate <b>100 trades</b> is about <b>+" + (st.exp * 100).toFixed(0) + "R</b>."
        : st.exp < -0.0001
          ? "At this rate <b>100 trades</b> costs about <b>&minus;" + Math.abs(st.exp * 100).toFixed(0) + "R</b>."
          : "Dead flat &mdash; the wins and losses cancel.";
      if (deep && dq.expLo <= 0 && dq.expHi >= 0) read += " The band still touches 0, so luck is not ruled out.";
    }
    cards.push(heroCard("Expectancy", has ? (st.exp >= 0 ? "+" : "") + st.exp.toFixed(2) + "R" : "n/a", tone, sub, viz, read));
  }

  // --- win rate: shown as the three outcomes it is actually made of ---
  {
    const decided = st.wins + st.losses;
    // the canonical record line, spelling out that a scratch sits in neither column
    const sub = st.wins + "W&ndash;" + st.losses + "L" + (st.scr ? "&ndash;" + st.scr + " scratch" : "") +
      (deep ? " &middot; 95% CI " + Math.round(dq.wrLo * 100) + "&ndash;" + Math.round(dq.wrHi * 100) + "%" : "");
    const read = !decided
      ? "Every trade here scratched at 0R."
      : "You win about <b>" + (st.wr * 10).toFixed(1) + " of every 10</b> decided trades." +
      (beWR != null ? " At your " + pay!.toFixed(2) + "x payoff, break-even sits at <b>" + Math.round(beWR * 100) + "%</b>." : "");
    cards.push(heroCard("Win rate", Math.round(st.wr * 100) + "%",
      beWR == null ? "" : st.wr > beWR ? "cell-go" : "cell-stop",
      sub, wlBars(st.wins, st.losses, st.scr), read));
  }

  // --- reward:risk, on a scale with the break-even mark drawn on it ---
  {
    let viz = "", sub: string, read: string, tone = "";
    if (pay == null) {
      sub = has ? "needs at least one winner and one loser with a risk basis" : "no risk basis logged yet";
      read = "This is the payoff half of the edge &mdash; without both sides there is nothing to divide.";
    } else {
      const cap = Math.max(3, Math.min(6, Math.ceil(Math.max(pay, bePay || 0) * 1.25)));
      const over = pay > cap;
      const c = bePay == null ? "var(--go)" : pay >= bePay ? "var(--go)" : "var(--stop)";
      viz = bar(seg(0, Math.min(100, (pay / cap) * 100), c) + intTicks(cap) + (bePay != null ? tick((Math.min(bePay, cap) / cap) * 100, true) : "")) +
        intScale(cap, over);
      tone = bePay == null ? "" : pay >= bePay ? "cell-go" : "cell-stop";
      sub = "avg winner +" + st.avgWin.toFixed(2) + "R vs avg loser &minus;" + st.avgLoss.toFixed(2) + "R";
      read = bePay == null
        ? "Your winners are " + pay.toFixed(2) + " times the size of your losers."
        : pay >= bePay
          ? "Break-even at your win rate is <b>" + bePay.toFixed(2) + "x</b> (the dark mark). You clear it."
          : "Break-even at your win rate is <b>" + bePay.toFixed(2) + "x</b> (the dark mark). You are under it &mdash; either the winners get bigger or the strike rate does.";
    }
    cards.push(heroCard("Reward : risk", pay == null ? "n/a" : pay.toFixed(2) + '<span class="u">x</span>', tone, sub, viz, read));
  }

  // --- profit factor as a share-of-gross dial ---
  {
    const noLoss = st.pf >= 99;
    const share = !has ? 0 : noLoss ? 1 : st.pf / (1 + st.pf);   // pf/(1+pf) = wins as a share of all gross movement
    const tone = !has ? "" : noLoss || st.pf >= 1.4 ? "cell-go" : st.pf >= 1 ? "cell-caution" : "cell-stop";
    const viz = gauge(share, "all loss", "1.00", "all win",
      has ? Math.round(share * 100) + "% of gross R landed on your side" : "no data yet");
    const sub = !has ? "no risk basis logged yet"
      : noLoss ? "no losing trade with a risk basis yet"
        : "1R of losses buys " + st.pf.toFixed(2) + "R of wins";
    const read = !has ? "Needs trades with a logged stop or risk amount."
      : noLoss ? "Nothing to divide by yet &mdash; one loser and this becomes a real number."
        : st.pf < 1 ? "Under 1.00 you are <b>paying to trade</b>: the losses are bigger than the wins."
          : st.pf < 1.25 ? "Just above water. A thin month erases it."
            : st.pf < 1.5 ? "A workable edge &mdash; the usual floor for something worth trading."
              : st.pf < 3 ? "A strong edge, if the sample is real."
                : "Very high &mdash; usually a short sample or one outsized winner, not a machine.";
    cards.push(heroCard("Profit factor", !has ? "n/a" : noLoss ? "no losers" : st.pf.toFixed(2), tone, sub, viz, read));
  }
  return '<div class="herogrid">' + cards.join("") + "</div>" + edgeRead(st, dq, deep, pay, bePay);
}
// the paragraph that ties the four together, because each one alone is a
// half-truth: win rate without payoff, payoff without win rate, both without n
function edgeRead(st: Stats, dq: Deep, deep: boolean, pay: number | null, bePay: number | null): string {
  void dq; void deep; void pay; void bePay;
  return st.rn ? "" : '<div class="note warn" style="margin:0 0 16px"><p class="h">No R basis</p><p style="margin:0">Add a stop, Risk $ or R override to your trades.</p></div>';
}
function renderStats() {
  const el = $("jv-stats"), list = filtered();
  if (!list.length) {
    el.innerHTML = segChipHtml() + '<div class="empty-state"><h3>No stats yet</h3><p>Log trades (or loosen the filters) to see your equity curve, calendar and breakdowns.</p></div>';
    wireSegChip(el);
    return;
  }
  const tabs: [string, string][] = [["perf", "Performance"], ["edge", "Edge report"], ["time", "Timing"], ["cal", "Calendar"]];
  if (tabs.every(([k]) => k !== STATS_TAB)) STATS_TAB = "perf";
  syncUnitSeg();
  let html = segChipHtml();
  html += '<div class="subnav" role="tablist" aria-label="Stats section">' +
    tabs.map(([k, lbl]) => '<button data-stat="' + k + '" aria-pressed="' + (STATS_TAB === k) + '">' + lbl + "</button>").join("") + "</div>";
  html += '<div id="st-body"></div>';
  el.innerHTML = html;
  wireSegChip(el);
  el.querySelectorAll<HTMLButtonElement>("button[data-stat]").forEach((b) =>
    b.addEventListener("click", () => {
      STATS_TAB = b.getAttribute("data-stat")!;
      LS.set("pel_stats_tab", STATS_TAB);
      renderStats();
    }));
  const body = document.getElementById("st-body")!;
  if (STATS_TAB === "perf") renderStatsPerf(body, list);
  else if (STATS_TAB === "edge") renderStatsEdge(body, list);
  else if (STATS_TAB === "time") renderStatsTiming(body, list);
  else renderStatsCal(body, list);
}

function renderStatsPerf(body: HTMLElement, list: Trade[]) {
  const st = stats(list);
  const dq = statsDeep(list);
  const sStart = scopeStart();
  const deep = dq.n >= 8;
  const tiles: string[] = [];

  {
    const notes: string[] = [];
    if (st.n > st.rn) notes.push(st.rn + " carry an R basis &mdash; the " + (st.n - st.rn) + " without a logged stop/risk count for dollars and win rate only");
    if (st.d$n > 0 && st.n > st.d$n) notes.push((st.n - st.d$n) + " carry no dollar basis, so no dollar total can include them");
    tiles.push(tileH("Trades", String(st.n), notes.length ? notes.join(" &middot; ") : undefined));
  }
  // Win rate, expectancy, reward:risk and profit factor are NOT repeated here.
  // They lead the page as the four headline cards above, each with its scale,
  // its reference mark and its reading - printing them a second time as bare
  // digits added a row of tiles and no information.
  tiles.push(tileH("Total R", (st.sumR >= 0 ? "+" : "") + st.sumR.toFixed(1),
    dq.n ? "peak " + (st.sumR + dq.curDD >= 0 ? "+" : "") + (st.sumR + dq.curDD).toFixed(1) + "R" : undefined));
  // The dollar tiles are the opt-in layer, gated on data rather than on the unit
  // switch. A total assembled from a SUBSET of the trades is the bug this
  // replaces, so a partly-priced scope names the gap and scopes its own subtotal
  // instead of printing a number that reads as the whole record.
  if (showDollars(st.d$n)) {
    const fn = st.n - st.d$n;
    tiles.push(fn === 0
      ? tileH("Total P&L", money(st.sum$), st.d$logged < st.d$n ? st.d$logged + " of " + st.d$n + " from logged P&amp;L, the rest priced from your R value" : undefined)
      : tileH("Total P&L", '<span class="unset">' + fn + " of " + st.n + " unpriced</span>",
        money(st.sum$) + " across the " + st.d$n + " that are priced &mdash; set what 1R is worth in the Equity panel to close the gap"));
    const m = scopeMoney();
    if (m.bal != null && m.ret != null) {
      tiles.push(tileH("Balance", money(m.bal),
        "start " + money(m.start!) + " &middot; " + (m.ret >= 0 ? "+" : "") + m.ret.toFixed(1) + "% return"));
    } else if (sStart != null) {
      tiles.push(tileH("Balance", '<span class="unset">' + m.unpriced + " of " + m.n + " unpriced</span>",
        "a balance built from part of the record is not a balance"));
    }
  }
  if (deep) {
    const sqnC = dq.sqn100 >= 2.5 ? "var(--go)" : dq.sqn100 >= 1.6 ? "var(--caution)" : "var(--stop)";
    tiles.push(tileH("SQN (Van Tharp)", dq.sqn100.toFixed(2),
      sqnLabel(dq.sqn100) + (dq.n > 100 ? " &middot; graded at n=100; full-sample t-stat " + dq.sqn.toFixed(2) : ""),
      bar(seg(0, Math.min(100, (dq.sqn100 / 6) * 100), sqnC) + tick((1.6 / 6) * 100) + tick((2.5 / 6) * 100))));
    tiles.push(tileH("&sigma; per trade", dq.sd.toFixed(2) + "R"));
    const ddFrac = dq.mdd > 0 ? Math.min(1, dq.curDD / dq.mdd) : 0;
    // "Max drawdown" read as a property of the edge; it is a property of THIS
    // path. The rename is the fix - the forward distribution is in the summary
    // box above, and calling this one "max" invited reading it as the maximum.
    tiles.push(tileH("Deepest drawdown so far", "&minus;" + dq.mdd.toFixed(1) + "R",
      dq.curDD > 0.5 ? "in one now: &minus;" + dq.curDD.toFixed(1) + "R" : "not in one now",
      bar(seg(0, ddFrac * 100, "var(--stop)"))));
    tiles.push(tileH("Streaks", dq.maxW + "W / " + dq.maxL + "L", "longest win / loss runs"));
    if (dq.kelly != null) {
      // f* IS AN INTERVAL, AND ITS LOSS FUNCTION IS NOT SYMMETRIC.
      //
      // A single "32%" hides a real range of roughly 15-47% on a 100-trade
      // record, because f* inherits the win-rate interval directly. And the two
      // directions do not cost the same: underbetting loses growth linearly,
      // while betting past ~2x f* drives expected log growth NEGATIVE - you
      // compound downward while still being right about the edge. Showing the
      // midpoint of that interval as the number is the wrong default for a
      // quantity whose downside is ruin, so the LOWER bound leads.
      const b = st.avgLoss > 0 ? st.avgWin / st.avgLoss : 0;
      const rdec = st.rwins + st.rlosses;
      const ci = rdec > 0 ? wilson(st.wrR, rdec) : { lo: st.wrR, hi: st.wrR };
      const fOf = (p: number) => (b > 0 ? p - (1 - p) / b : 0);
      const kLo = fOf(ci.lo), kHi = fOf(ci.hi);
      // the scale runs to twice f*, because that is where growth turns negative
      // and it is the only reference point on this axis that means anything
      const ruin = Math.max(0, dq.kelly) * 2;
      const K = Math.max(40, ruin * 100 * 1.1);
      const pctOf = (v: number) => (Math.max(0, v * 100) / K) * 100;
      tiles.push(tileH("Kelly f*",
        (Math.max(0, kLo) * 100).toFixed(0) + "&ndash;" + (Math.max(0, kHi) * 100).toFixed(0) + "%",
        "point " + (dq.kelly * 100).toFixed(0) + "% &middot; half-Kelly " + (dq.kelly * 50).toFixed(0) +
        "% &middot; tick = where growth turns negative (" + (ruin * 100).toFixed(0) + "%)",
        bar(seg(pctOf(kLo), Math.max(1, pctOf(kHi) - pctOf(kLo)), dq.kelly > 0 ? "var(--go)" : "var(--stop)") +
          tick(pctOf(dq.kelly)) + tick(pctOf(ruin), true))));
    } else tiles.push(tileH("Kelly f*", "n/a"));
    {
      // recent form vs the whole record on one zero-centred bar
      const L2 = Math.max(Math.abs(dq.recent), Math.abs(dq.exp), 0.1) * 1.3;
      const XR = (v: number) => ((v + L2) / (2 * L2)) * 100;
      const from = Math.min(50, XR(dq.recent)), w = Math.abs(XR(dq.recent) - 50);
      tiles.push(tileH("Recent form (last " + dq.recN + ")", (dq.recent >= 0 ? "+" : "") + dq.recent.toFixed(2) + "R",
        "vs " + (dq.exp >= 0 ? "+" : "") + dq.exp.toFixed(2) + "R overall",
        bar(seg(from, w, dq.recent >= 0 ? "var(--go)" : "var(--stop)") + tick(50) + tick(XR(dq.exp), true))));
    }
    if (dq.share != null) {
      // THE FIRM MEASURES THIS OVER AN EVALUATION, NOT OVER YOUR WHOLE RECORD.
      //
      // The lifetime figure is mechanically the flatterer: concentration over 100
      // trades is far lower than over the 12-25 days one evaluation takes, so a
      // trader reading "25% against a 30% cap" believes they clear a rule they may
      // breach routinely. consWindows (plan.ts) already walks the record the way
      // the engine walks a simulated one - it is what My firm uses - so the honest
      // number is the WORST window, and the lifetime share becomes the footnote.
      const { firm } = firmFor();
      const evalRisk = Number($i("src").value) || 0.75;
      const cap = firm.cons > 0 ? firm.cons : 30;
      const needR = evalRisk > 0 ? firm.p1 / evalRisk : 0;
      const w = consWindows(dayRs(list), needR, cap);
      const shown = w.windows > 0 ? w.worst : dq.share;
      const S3 = Math.max(50, shown * 100 * 1.2, cap * 1.2);
      tiles.push(tileH("Best-day share",
        Math.round(shown * 100) + "%",
        w.windows > 0
          ? "worst of " + w.windows + " target-sized window" + (w.windows === 1 ? "" : "s") +
            (w.blocked > 0 ? " &middot; <b>" + w.blocked + " would breach the " + cap + "% cap</b>" : " &middot; clears the " + cap + "% cap") +
            " &middot; lifetime " + Math.round(dq.share * 100) + "%"
          : "lifetime figure &mdash; your record has not yet made one evaluation target at " + evalRisk.toFixed(2) +
            "% risk, so there is no window to measure &middot; tick = " + cap + "% cap",
        bar(seg(0, ((shown * 100) / S3) * 100, shown > cap / 100 ? "var(--stop)" : shown > (cap / 100) * 0.8 ? "var(--caution)" : "var(--go)") +
          tick((cap / S3) * 100))));
    } else tiles.push(tileH("Best-day share", "n/a"));
    tiles.push(tileH("Tail ratio", dq.tail != null ? dq.tail.toFixed(1) + "x" : "n/a", dq.tail != null ? "worst vs avg loss" : ""));
  }
  // One long wall of equal-weight boxes gave the eye nowhere to land. The same
  // tiles, split into labelled sections: what the edge is, what it has made,
  // what it costs to hold, the curves, the exits - and the prop odds last,
  // because they only matter to someone trading a firm's account.
  const RISK = ["&sigma; per trade", "Deepest drawdown", "Streaks", "Kelly", "Best-day share", "Tail ratio"];
  const isRisk = (t: string) => RISK.some((k) => t.indexOf(">" + k) >= 0);
  const sec = (t: string, first?: boolean) => '<div class="psec' + (first ? " first" : "") + '">' + t + "</div>";
  let html = sec("Edge", true) + renderHeroes(st, dq, deep);
  html += sec("Results") + '<div class="statgrid g3">' + tiles.filter((t) => !isRisk(t)).join("") + "</div>";
  const riskTiles = tiles.filter(isRisk);
  if (riskTiles.length) html += sec("Risk") + '<div class="statgrid g3">' + riskTiles.join("") + "</div>";
  if (!deep) html += '<p class="small muted" style="margin:2px 0 16px">More stats at 8+ resolved trades.</p>';
  html += sec("Equity &amp; distribution");
  html += '<div class="chartgrid"><div><div class="vh" style="margin-top:0">Equity curve (R, oldest &rarr; newest)</div><canvas id="cEquity" height="200"></canvas></div>' +
    '<div><div class="vh" style="margin-top:0">R-multiple distribution</div><canvas id="cRdist" height="200"></canvas></div></div>';
  html += '<div class="vh" style="margin-top:16px">Rolling expectancy &mdash; is the edge drifting?</div><canvas id="cRolling" height="150"></canvas>';
  html += sec("Exits &amp; targets") + '<div id="exitEff"></div>';
  html += '<div class="vh">Target sweep &mdash; what should the R:R be?</div><div id="tgtSweep"></div>';
  if (view.PROP) html += sec("Prop odds") + '<div class="vh" style="margin-top:0">Your journaled edge vs the firm</div><div class="statgrid" id="propOdds" style="margin-bottom:16px"></div>';
  body.innerHTML = html;
  drawEquity(list);
  drawRdist(dq.rs);
  drawRolling(list);
  renderExitEff(list);
  renderTargetSweep(list);
  renderPropOdds();
  wireTips(body);
}

function renderStatsEdge(body: HTMLElement, list: Trade[]) {
  let html = '<div class="vh" style="margin-top:0">Edge report &mdash; strengths &amp; leaks</div><div id="edgeReport"></div>';
  html += '<div class="vh" style="margin-top:18px">Direction</div><div id="longShort"></div>';
  html += '<div class="vh" style="margin-top:16px">By entry model</div><div id="bkModel"></div>';
  html += '<div class="chartgrid" style="margin-top:16px"><div><div class="vh">By setup</div><div id="bkSetup"></div></div><div><div class="vh">By quality tag</div><div id="bkQual"></div></div></div>';
  // The session map gets a row of its own: paired against a short table it left
  // most of a column empty, because a chart and a six-row table are not the same
  // height. Picture on the left, its numbers on the right.
  html += '<div class="vh" style="margin-top:18px">By session &mdash; where your R comes from</div>' +
    '<div class="chartgrid"><div><canvas id="cSess" height="240"></canvas></div><div><div id="sessBW"></div><div id="bkSess"></div></div></div>';
  // Weekday, entry hour and holding time used to sit here in a .grid3. They moved
  // to the Timing tab, and that is a real improvement to THIS tab and not just
  // tidier navigation: this screen is the one that issues LEAN IN / CUT THESE
  // over ~17 subgroups with no multiplicity control, and three fewer dimensions
  // is three fewer ways for the scan to find something that is not there.
  body.innerHTML = html;
  renderEdgeReport(list);
  renderLongShort(list);
  renderSessionMap(list);
  renderModelTable("bkModel", list);
  breakdownBy("bkSetup", list, (t) => t.setup || "(none)");
  breakdownBy("bkQual", list, (t) => (t.tags && t.tags.quality) || "(untagged)");
  breakdownBy("bkSess", list, sessionOf);
}

// ---------- TIMING: when you traded, and what that cost ----------
//
// WHY ITS OWN TAB. Weekday, entry hour and holding time answer "when", which is
// a different question from the Edge report's "what" - and moving them takes
// three dimensions off the scan behind that screen's LEAN IN / CUT THESE.
//
// WHAT MAKES IT HARD. Twenty-four hour buckets scanned for the best one is
// precisely the null cutNoise() was written against: on 60 records where
// membership is random BY CONSTRUCTION, the best of ~34 segments looked like a
// gain 60 times out of 60, and a bootstrap band ALONE still called 13 of them
// real. So the tables here describe and never rank, and the single block that
// calls a bucket real has to clear both of cutStat's bars first.
//
// THE CLOCK IS THE USER'S. The hour is read off the timestamp exactly as it was
// typed - never converted to exchange time, because this file cannot know which
// exchange. The session TAG is the answer to market timing and stays where it is.
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// The weekday of a trade, or null when it carries no usable date.
//
// Parsed from the string's own components, deliberately. `new Date("2026-08-02")`
// is UTC midnight per spec while `new Date("2026-08-02T09:30")` is LOCAL, and the
// importer does not validate the shape (safeStr only, journal.ts:sanitize) - so
// a date-only row anywhere west of UTC landed on the previous weekday, silently,
// in every By-weekday reading this app has printed since the table shipped.
export function dowOf(t: Trade): number | null {
  const s = (t.dateTime || "").slice(0, 10);
  if (s.length !== 10) return null;
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  if (!isFinite(y) || !isFinite(m) || !isFinite(d) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d);
  return isNaN(dt.getTime()) ? null : dt.getDay();
}
// The entry hour 0-23, or null when the row has a date but no time on it.
export function hourOf(t: Trade): number | null {
  const s = t.dateTime || "";
  if (s.length < 16 || s[10] !== "T") return null;
  const h = +s.slice(11, 13);
  return isFinite(h) && h >= 0 && h <= 23 ? h : null;
}
// "09:00-10:00" - the user asked for the range, and an hour printed as a single
// instant is ambiguous about which side of it the trades fall on.
export function hourLabel(h: number): string {
  return pad2(h) + ":00-" + pad2((h + 1) % 24) + ":00";
}
export function durBucket(m: number): { k: string; ord: number } {
  return m < 5 ? { k: "under 5m", ord: 0 } : m < 15 ? { k: "5-15m", ord: 1 }
    : m < 60 ? { k: "15-60m", ord: 2 } : m < 240 ? { k: "1-4h", ord: 3 } : { k: "over 4h", ord: 4 };
}

// Which trade of its own day this was. Ordered by dateTime and THEN createdAt -
// the same comparator statsDeep uses, because dateTime only carries minute
// resolution and two trades in one minute would otherwise order arbitrarily.
export function dayOrdinals(list: Trade[]): Record<string, number> {
  const byDay: Record<string, Trade[]> = {};
  list.forEach((t) => {
    const d = (t.dateTime || "").slice(0, 10);
    if (d.length === 10) (byDay[d] = byDay[d] || []).push(t);
  });
  const out: Record<string, number> = {};
  Object.keys(byDay).forEach((d) => {
    byDay[d].slice().sort((a, b) =>
      (a.dateTime || "").localeCompare(b.dateTime || "") || (a.createdAt || 0) - (b.createdAt || 0))
      .forEach((t, i) => { out[t.id] = i + 1; });
  });
  return out;
}

// Minutes between a LOSING exit and the next entry on the same account. This is
// where a revenge trade becomes a number, and it needs nothing new logged - only
// an exit time on the trade that lost. Per account, because two accounts traded
// in parallel are not one sequence (Trap #20's neighbour).
export function postLossGaps(list: Trade[]): Record<string, number> {
  const byAcct: Record<string, Trade[]> = {};
  list.forEach((t) => { (byAcct[accOf(t)] = byAcct[accOf(t)] || []).push(t); });
  const out: Record<string, number> = {};
  Object.keys(byAcct).forEach((a) => {
    const ts = byAcct[a].slice().sort((x, y) =>
      (x.dateTime || "").localeCompare(y.dateTime || "") || (x.createdAt || 0) - (y.createdAt || 0));
    for (let i = 1; i < ts.length; i++) {
      const prev = ts[i - 1], cur = ts[i];
      if (!isResolved(prev) || !hasRBasis(prev) || tradeR(prev) >= 0) continue;
      if (!prev.exitTime || !cur.dateTime) continue;
      const a0 = new Date(prev.exitTime).getTime(), b0 = new Date(cur.dateTime).getTime();
      if (!isFinite(a0) || !isFinite(b0) || b0 < a0) continue;
      out[cur.id] = (b0 - a0) / 60000;
    }
  });
  return out;
}

interface TimeRow {
  k: string; ord: number;
  n: number; wr: number; wrLo: number; wrHi: number;
  rr: number | null; exp: number; sumR: number;
  rs: number[];
  durN: number; durMed: number | null;
  winDurMed: number | null; lossDurMed: number | null;
  planN: number; planRR: number | null; capW: number | null;
  // How far it RAN, in R - SPLIT BY OUTCOME, never pooled.
  //
  // A median MFE over all trades at once is a bimodal mixture and it lies. On a
  // 170-trade demo the losers sat around 0.5R and the winners around 2-4R with an
  // empty gap between, so the pooled median simply reported WHICH SIDE OF 50% THE
  // WIN RATE WAS ON: 0.61R at a 30% hour and 3.60R at a 57% one, which reads as
  // "trades run six times further in the morning" when the winners had only
  // doubled. At a 50% hour it printed 1.13R - a value no trade in the bucket had,
  // interpolated across the gap. Two clean populations, or none.
  mfeN: number;
  mfeWinN: number; mfeWinMed: number | null;
  mfeLossN: number; mfeLossMed: number | null;
}
type TimeKey = { k: string; ord: number } | null;

function medOf(a: number[]): number | null {
  if (!a.length) return null;
  return pctl(a.slice().sort((x, y) => x - y), 0.5);
}

// Every statistic on this tab runs over resolved trades carrying a MEASURED risk
// basis (Trap #2). Without hasRBasis a bucket fills quietly with computeRraw's
// sign(pnl) fallback, and a table of invented +-1R is worse than no table.
export function timeBuckets(list: Trade[], keyFn: (t: Trade) => TimeKey): { rows: TimeRow[]; uncovered: number } {
  const groups: Record<string, { ord: number; ts: Trade[] }> = {};
  let uncovered = 0;
  list.filter((t) => isResolved(t) && hasRBasis(t)).forEach((t) => {
    const key = keyFn(t);
    // NOT dropped silently. A trade this axis cannot place is a gap in the
    // record, and the panel names it - the same rule that stops an unpriceable
    // trade being counted as $0 (Trap #21). The old By-entry-hour table filtered
    // these out with a .filter() before it ever counted them, so a record where
    // half the rows had no time looked complete.
    if (!key) { uncovered++; return; }
    (groups[key.k] = groups[key.k] || { ord: key.ord, ts: [] }).ts.push(t);
  });
  const rows: TimeRow[] = Object.keys(groups).map((k) => {
    const ts = groups[k].ts, s = stats(ts);
    // Trap #16: the RATE and its interval run over DECIDED trades - a 0R scratch
    // is real data worth exactly 0R, not a loss - expectancy runs over them all.
    const dec = s.rwins + s.rlosses;
    const ci = dec > 0 ? wilson(s.wrR, dec) : { lo: 0, hi: 0 };
    const durs = ts.map(durationMin).filter((m): m is number => m != null);
    const wd = ts.filter((t) => tradeR(t) > 0).map(durationMin).filter((m): m is number => m != null);
    const ld = ts.filter((t) => tradeR(t) < 0).map(durationMin).filter((m): m is number => m != null);
    const prs: number[] = [], caps: number[] = [];
    ts.forEach((t) => {
      const pr = plannedRR(t);
      if (pr == null || !isFinite(pr) || pr <= 0) return;
      prs.push(pr);
      // Capture is defined over WINNERS only, and that is what makes it readable:
      // "of the target you set, how much you actually took when it worked". Over
      // every trade it would collapse into expectancy divided by a plan, which is
      // a number nobody can act on.
      if (tradeR(t) > 0) caps.push(tradeR(t) / pr);
    });
    const mfes = ts.map((t) => excursions(t).mfeR).filter((v): v is number => v != null && isFinite(v));
    const mfeOf = (keep: (t: Trade) => boolean) => ts.filter(keep)
      .map((t) => excursions(t).mfeR).filter((v): v is number => v != null && isFinite(v));
    const mfeWin = mfeOf((t) => tradeR(t) > 0);
    const mfeLoss = mfeOf((t) => tradeR(t) < 0);
    return {
      k, ord: groups[k].ord, n: s.n, wr: s.wrR, wrLo: ci.lo, wrHi: ci.hi,
      rr: payoff(s), exp: s.exp, sumR: s.sumR, rs: ts.map(tradeR),
      durN: durs.length, durMed: medOf(durs),
      winDurMed: medOf(wd), lossDurMed: medOf(ld),
      planN: prs.length, planRR: medOf(prs), capW: medOf(caps),
      mfeN: mfes.length,
      mfeWinN: mfeWin.length, mfeWinMed: medOf(mfeWin),
      mfeLossN: mfeLoss.length, mfeLossMed: medOf(mfeLoss),
    };
  });
  // BY THE AXIS, ALWAYS - never by R. The old weekday and holding-time tables
  // sorted by total R (breakdownBy's default), which is why no weekly or
  // duration pattern was ever legible in them: Thursday sat between Monday and
  // Saturday only by accident, and "over 4h" could outrank "under 5m".
  rows.sort((a, b) => a.ord - b.ord);
  return { rows, uncovered };
}

// A bucket's expectancy as a zero-centred bar on ONE shared scale, which the
// column header names. renderMfeSession says it best: a band with no stated
// maximum is a shape, not a measurement.
function expMeter(exp: number, scale: number): string {
  if (!(scale > 0)) return bar("");
  const half = Math.max(0, Math.min(50, (Math.abs(exp) / scale) * 50));
  const left = exp >= 0 ? 50 : 50 - half;
  return bar(seg(left, Math.max(0.8, half), exp >= 0 ? "var(--go)" : "var(--stop)") + tick(50));
}

// One dimension's table. Wrapped in .scroll because it carries more columns than
// anything else in the app and the sidebar leaves ~630px at the 980px breakpoint
// the mac overflow test pins - a table that scrolls inside its own box is the
// existing idiom for that, and it never pushes the PAGE sideways.
function timeTableHtml(rows: TimeRow[], firstCol: string): string {
  if (!rows.length) return '<p class="small muted plan-note2">No trades can be placed on this axis yet.</p>';
  let scale = 0;
  rows.forEach((r) => { if (Math.abs(r.exp) > scale) scale = Math.abs(r.exp); });
  scale = Math.max(0.25, Math.ceil(scale * 4) / 4);
  const anyPlan = rows.some((r) => r.planN > 0);
  const anyDur = rows.some((r) => r.durN > 0);
  const anyMfe = rows.some((r) => r.mfeN > 0);
  let html = '<div class="scroll"><table class="breakdown"><thead><tr><th>' + esc(firstCol) +
    "</th><th>n</th><th>win%</th><th>RR</th><th>exp</th><th>R</th>" +
    (anyDur ? '<th class="x2">held</th><th class="x2">win / loss held</th>' : "") +
    (anyPlan ? '<th class="x2">planned RR</th><th class="x2">kept</th>' : "") +
    // MFE - how far price got in your favour before the trade ended - split by
    // outcome and never pooled. WON answers "when it worked, where did price
    // actually get to", which is the question a fixed target is answered by.
    // LOST answers "how close did the failures get", which is the other half:
    // losers dying at 1.2R against a 1.5R target is a different problem from
    // losers dying at 0.3R, and only one of them is about the target.
    (anyMfe ? '<th class="x2">ran to (won)</th><th class="x2">ran to (lost)</th>' : "") +
    '<th class="tw">expectancy &plusmn;' + scale.toFixed(2) + "R</th></tr></thead><tbody>";
  rows.forEach((r) => {
    const cls = r.sumR > 0.0001 ? "cell-go" : r.sumR < -0.0001 ? "cell-stop" : "";
    const thin = r.n < 4;
    html += "<tr" + (thin ? ' class="thin" title="Only ' + r.n + " trade" + (r.n === 1 ? "" : "s") +
      ' - too few to read anything into"' : "") + "><td>" + esc(r.k) + "</td><td>" + r.n + "</td><td>" +
      Math.round(r.wr * 100) + '%<span class="tsub">' + Math.round(r.wrLo * 100) + "-" + Math.round(r.wrHi * 100) + "</span></td><td>" +
      (r.rr == null ? "--" : r.rr.toFixed(2)) + "</td><td>" +
      (r.exp >= 0 ? "+" : "") + r.exp.toFixed(2) + '</td><td class="' + cls + '">' +
      (r.sumR >= 0 ? "+" : "") + r.sumR.toFixed(1) + "</td>" +
      (anyDur
        ? '<td class="x2">' + (r.durMed == null ? "--" : esc(fmtDur(r.durMed))) + '</td><td class="x2">' +
          (r.winDurMed == null && r.lossDurMed == null ? "--"
            : (r.winDurMed == null ? "--" : esc(fmtDur(r.winDurMed))) + " / " +
              (r.lossDurMed == null ? "--" : esc(fmtDur(r.lossDurMed)))) + "</td>"
        : "") +
      (anyPlan
        ? '<td class="x2">' + (r.planRR == null ? "--" : r.planRR.toFixed(2)) + '</td><td class="x2">' +
          (r.capW == null ? "--" : Math.round(r.capW * 100) + "%") + "</td>"
        : "") +
      (anyMfe
        // green only when the winners ran materially past the target you set:
        // that is a target question, and it is the one cell on this row that
        // points at a change you can actually make
        ? '<td class="x2 ' + (r.mfeWinMed != null && r.planRR != null && r.mfeWinMed > r.planRR * 1.25 ? "cell-go" : "") + '">' +
          (r.mfeWinMed == null ? "--" : r.mfeWinMed.toFixed(2) + "R") + "</td>" +
          // amber when the losers were dying close to the target: those are the
          // trades a SMALLER target would have converted, and the two columns
          // together are the whole trade-off
          '<td class="x2 ' + (r.mfeLossMed != null && r.planRR != null && r.mfeLossMed > r.planRR * 0.66 ? "cell-caution" : "") + '">' +
          (r.mfeLossMed == null ? "--" : r.mfeLossMed.toFixed(2) + "R") + "</td>"
        : "") +
      '<td class="tw">' + expMeter(r.exp, scale) + "</td></tr>";
  });
  return html + "</tbody></table></div>";
}

// What the tables cannot show, stated rather than left to be discovered. Trap
// #21's rule generalised from dollars to coverage: name the gap, do not quietly
// shrink the denominator until the record looks complete.
function coverageNote(rows: TimeRow[], uncovered: number, axis: string, total: number): string {
  const bits: string[] = [];
  // blank columns (no exit time, no planned R:R, no MFE) are explained in the
  // user manual; only trades missing from the table altogether are called out
  void rows;
  if (uncovered > 0) bits.push("<b>" + uncovered + "</b> of " + total + " trades have no " + axis);
  return bits.length ? '<p class="small muted plan-note2">' + bits.join(" &middot; ") + ".</p>" : "";
}

// ---- the one block on this tab that calls a bucket real ----
//
// Everything above describes. This decides, and a decision reached by scanning
// buckets for the most striking one is exactly the null journal.ts's
// counterfactual measured: the bootstrap band ALONE let 13 of 60 pure-noise
// segments through, ~78% coverage against a nominal 90%. Both bars call 0 of 60.
//
// `choices` is the size of the whole scan, summed ACROSS the dimensions on
// screen, not per table. The trader is looking at all four axes at once, so
// correcting each one for its own bucket count would be four uncorrected looks
// wearing a correction. A bucket under the n>=4 house floor was never in the
// running and does not inflate the count.
const SEP_MIN_BUCKET = 4;
interface SepRead { axis: string; row: TimeRow; st: CutStat; restN: number; restExp: number }
let SEP_CACHE: { key: string; val: { best: SepRead | null; choices: number } } | null = null;
let SEP_CANCEL: (() => void) | null = null;
type SepCand = { axis: string; row: TimeRow; all: number[]; rest: number[] };
export function separability(dims: { axis: string; rows: TimeRow[] }[]): { best: SepRead | null; choices: number } {
  const { cands, choices } = sepCands(dims);
  if (!cands.length || choices < 2) return { best: null, choices };
  let win: SepRead | null = null;
  cands.forEach((c) => { win = sepPick(win, c, choices); });
  return { best: win, choices };
}
// The same verdict, one candidate per macrotask: each candidate's bootstrap and
// noise floor is ~100ms on a 1,000-trade record, and doing all of them in one
// block froze the window for half a second whenever the Timing tab opened.
function separabilityAsync(dims: { axis: string; rows: TimeRow[] }[], done: (r: { best: SepRead | null; choices: number }) => void): () => void {
  const { cands, choices } = sepCands(dims);
  let cancelled = false, win: SepRead | null = null, i = 0;
  if (!cands.length || choices < 2) { setTimeout(() => { if (!cancelled) done({ best: null, choices }); }, 0); return () => { cancelled = true; }; }
  let gen: Generator<void, SepRead> | null = null;
  const step = () => {
    if (cancelled) return;
    const t0 = performance.now();
    while (performance.now() - t0 < 12) {
      if (!gen) {
        if (i >= cands.length) { done({ best: win, choices }); return; }
        gen = sepPickGen(win, cands[i++], choices);
      }
      const r = gen.next();
      if (r.done) { win = r.value; gen = null; }
    }
    setTimeout(step, 0);
  };
  setTimeout(step, 0);
  return () => { cancelled = true; };
}
function sepPick(win: SepRead | null, c: SepCand, choices: number): SepRead {
  return runGen(sepPickGen(win, c, choices));
}
function* sepPickGen(win: SepRead | null, c: SepCand, choices: number): Generator<void, SepRead> {
  const st = yield* cutStatGen(c.row.rs, c.rest, choices);
  const restExp = c.rest.length ? c.rest.reduce((a, b) => a + b, 0) / c.rest.length : 0;
  return !win || Math.abs(st.d) > Math.abs(win.st.d) ? { axis: c.axis, row: c.row, st, restN: c.rest.length, restExp } : win;
}
function sepCands(dims: { axis: string; rows: TimeRow[] }[]): { cands: SepCand[]; choices: number } {
  let choices = 0;
  const cands: { axis: string; row: TimeRow; all: number[]; rest: number[] }[] = [];
  dims.forEach((d) => {
    const all: number[] = [];
    d.rows.forEach((r) => { all.push(...r.rs); });
    if (all.length < CUT_MIN_N) return;
    const eligible = d.rows.filter((r) => r.rs.length >= SEP_MIN_BUCKET && r.rs.length < all.length);
    if (eligible.length < 2) return;
    choices += eligible.length;
    const mean = all.reduce((a, b) => a + b, 0) / all.length;
    let best: TimeRow | null = null, bestD = -1;
    eligible.forEach((r) => {
      const m = r.rs.reduce((a, b) => a + b, 0) / r.rs.length;
      if (Math.abs(m - mean) > bestD) { bestD = Math.abs(m - mean); best = r; }
    });
    if (!best) return;
    const pick = best as TimeRow;
    const rest: number[] = [];
    d.rows.forEach((r) => { if (r !== pick) rest.push(...r.rs); });
    cands.push({ axis: d.axis, row: pick, all, rest });
  });
  return { cands, choices };
}

function sepBlockHtml(sep: { best: SepRead | null; choices: number }): string {
  const b = sep.best;
  if (!b) {
    return '<div class="note"><p class="h">Too few trades to test timing</p>' +
      "<p class=\"nomarg\">Needs " + CUT_MIN_N + "+ trades on an axis, in 2+ buckets of " + SEP_MIN_BUCKET + "+.</p></div>";
  }
  const st = b.st;
  const gap = (st.d >= 0 ? "+" : "") + st.d.toFixed(2) + "R";
  const bucketExp = (b.row.exp >= 0 ? "+" : "") + b.row.exp.toFixed(2) + "R";
  const restExp = (b.restExp >= 0 ? "+" : "") + b.restExp.toFixed(2) + "R";
  const line = "<b>" + esc(b.row.k) + "</b> (" + esc(b.axis) + "): <b>" + bucketExp + "</b> over " + b.row.n +
    " vs <b>" + restExp + "</b> for the rest &middot; gap " + gap + " &middot; noise floor " + st.noise.toFixed(2) + "R";
  return st.separable
    ? '<div class="note"><p class="h">' + esc(b.row.k) + " stands out</p><p class=\"nomarg\">" + line + "</p></div>"
    : '<div class="note"><p class="h">Nothing stands out yet</p><p class="nomarg">' + line + "</p></div>";
}

// The day-level companion to "which trade of the day". A day that made +2R on two
// trades and a day that made +2R on nine are the same row everywhere else in this
// app, and the difference between them is the whole question here: the DAILY LOSS
// LIMIT is the rule that actually ends prop accounts, and it is a property of the
// day, not of any trade in it.
interface DayCountRow { k: string; ord: number; days: number; totR: number; medR: number | null; green: number }
export function dayCountRows(list: Trade[]): DayCountRow[] {
  const byDay: Record<string, number[]> = {};
  list.filter((t) => isResolved(t) && hasRBasis(t)).forEach((t) => {
    const d = (t.dateTime || "").slice(0, 10);
    if (d.length === 10) (byDay[d] = byDay[d] || []).push(tradeR(t));
  });
  const buckets: Record<string, { ord: number; totals: number[] }> = {};
  Object.keys(byDay).forEach((d) => {
    const rs = byDay[d], c = rs.length;
    const k = c >= 5 ? "5+ trades" : c === 1 ? "1 trade" : c + " trades";
    let tot = 0;
    rs.forEach((r) => { tot += r; });
    (buckets[k] = buckets[k] || { ord: Math.min(c, 5), totals: [] }).totals.push(tot);
  });
  return Object.keys(buckets).map((k) => {
    const tt = buckets[k].totals;
    let tot = 0;
    tt.forEach((v) => { tot += v; });
    return { k, ord: buckets[k].ord, days: tt.length, totR: tot, medR: medOf(tt), green: tt.filter((v) => v > 0).length };
  }).sort((a, b) => a.ord - b.ord);
}
function dayCountHtml(rows: DayCountRow[]): string {
  if (!rows.length) return '<p class="small muted plan-note2">No dated trading days to count yet.</p>';
  let html = '<div class="scroll"><table class="breakdown"><thead><tr><th>on a day with</th><th>days</th><th>green days</th><th>median day</th><th>total R</th></tr></thead><tbody>';
  rows.forEach((r) => {
    const cls = r.totR > 0.0001 ? "cell-go" : r.totR < -0.0001 ? "cell-stop" : "";
    html += "<tr" + (r.days < 4 ? ' class="thin" title="Only ' + r.days + " day" + (r.days === 1 ? "" : "s") +
      ' - too few to read anything into"' : "") + "><td>" + esc(r.k) + "</td><td>" + r.days + "</td><td>" +
      Math.round((r.green / r.days) * 100) + "%</td><td>" +
      (r.medR == null ? "--" : (r.medR >= 0 ? "+" : "") + r.medR.toFixed(2)) + '</td><td class="' + cls + '">' +
      (r.totR >= 0 ? "+" : "") + r.totR.toFixed(1) + "</td></tr>";
  });
  return html + "</tbody></table></div>";
}

function renderStatsTiming(body: HTMLElement, list: Trade[]) {
  const total = list.filter((t) => isResolved(t) && hasRBasis(t)).length;
  if (!total) {
    body.innerHTML = '<div class="empty-state"><p>Nothing to time yet</p><p class="small muted">Log a few resolved trades with a Risk $ or a stop and this reads back what your entry hour, your weekday and how long you hold are doing to your R.</p></div>';
    return;
  }
  const ordm = dayOrdinals(list);
  const gaps = postLossGaps(list);
  const hours = timeBuckets(list, (t) => { const h = hourOf(t); return h == null ? null : { k: hourLabel(h), ord: h }; });
  // Mon first: (d + 6) % 7 maps Sun(0) to the end, which is how a trading week
  // reads. Sorting by R put Thursday between Monday and Saturday.
  const dows = timeBuckets(list, (t) => { const d = dowOf(t); return d == null ? null : { k: DOW[d], ord: (d + 6) % 7 }; });
  const durs = timeBuckets(list, (t) => { const m = durationMin(t); return m == null ? null : durBucket(m); });
  const nths = timeBuckets(list, (t) => {
    const i = ordm[t.id];
    return i == null ? null : { k: i >= 5 ? "5th+" : ["1st", "2nd", "3rd", "4th"][i - 1], ord: Math.min(i, 5) };
  });
  const lat = timeBuckets(list, (t) => {
    const g = gaps[t.id];
    if (g == null) return null;
    return g < 5 ? { k: "under 5m", ord: 0 } : g < 15 ? { k: "5-15m", ord: 1 }
      : g < 60 ? { k: "15-60m", ord: 2 } : { k: "over 1h", ord: 3 };
  });

  // The verdict is corrected for every bucket on the screen at once, so it is
  // computed over all the testable axes before any of them is drawn.
  //
  // HOLDING TIME IS DELIBERATELY NOT IN HERE, and leaving it in was a real bug
  // caught on a demo record: it announced "1-4h separates, +1.50R against
  // -0.45R, both bars cleared" on a fixture where holding time carried no
  // information at all. It cannot carry any. A winner runs to its target and is
  // therefore held for hours; a loser hits its stop in minutes. The bucket is
  // ASSIGNED BY THE OUTCOME, so of course the long buckets win - and no bootstrap
  // or permutation floor can see that, because the association is real, it is
  // just backwards. The test only belongs on axes you can choose BEFORE the
  // trade: which hour, which weekday, how many trades in already, how long you
  // waited after a loss. Holding time keeps its table and loses its verdict.
  const sepDims = [
    { axis: "entry hour", rows: hours.rows },
    { axis: "weekday", rows: dows.rows },
    { axis: "trade of the day", rows: nths.rows },
    { axis: "wait after a loss", rows: lat.rows },
  ];
  // tables first; the verdict fills in when its (sliced) computation lands, and
  // is cached on the record so reopening the tab is instant
  let sumR = 0;
  list.forEach((t) => { sumR += tradeR(t) || 0; });
  const sepKey = ACCT + "|" + list.length + "|" + sumR.toFixed(4);
  const sepHit = SEP_CACHE && SEP_CACHE.key === sepKey ? SEP_CACHE.val : null;

  const more = LS.get<boolean>("pel_time_more", false);
  let html = '<div class="tmorebar"><button type="button" class="barbtn" id="tMore" aria-pressed="' + more + '">' + (more ? "Fewer columns" : "More columns") + "</button></div>" +
    '<div class="vh vh0">Does any of it hold up?</div><div id="sepBox">' +
    (sepHit ? sepBlockHtml(sepHit) : '<div class="note"><p class="h">Testing&hellip;</p><p class="nomarg"><span class="skel"></span></p></div>') + "</div>";

  html += '<div class="vh">By entry hour &mdash; your clock</div>' +
    timeTableHtml(hours.rows, "hour") +
    coverageNote(hours.rows, hours.uncovered, "time of day", total);

  html += '<div class="vh">By weekday</div>' +
    timeTableHtml(dows.rows, "day") +
    coverageNote(dows.rows, dows.uncovered, "date", total);

  html += '<div class="vh">By holding time</div>' +
    timeTableHtml(durs.rows, "held for") +
    coverageNote(durs.rows, durs.uncovered, "exit time", total);

  html += '<div class="vh">Which trade of the day</div>' +
    timeTableHtml(nths.rows, "trade") +
    coverageNote(nths.rows, nths.uncovered, "date", total);

  html += '<div class="vh">After a loss &mdash; how long you waited</div>' +
    timeTableHtml(lat.rows, "waited") +
    (lat.rows.length
      ? coverageNote(lat.rows, 0, "preceding loss with an exit time", total)
      : '<p class="small muted plan-note2">Needs exit times on losing trades.</p>');

  html += '<div class="vh">By how busy the day was</div>' +
    dayCountHtml(dayCountRows(list));

  // What is deliberately NOT here, and why - the app says so rather than leaving
  // its absence to look like an oversight.


  body.innerHTML = html;
  body.classList.toggle("tmore", more);
  if (!sepHit) {
    if (SEP_CANCEL) SEP_CANCEL();
    SEP_CANCEL = separabilityAsync(sepDims, (r) => {
      SEP_CANCEL = null;
      SEP_CACHE = { key: sepKey, val: r };
      const box = document.getElementById("sepBox");
      if (box) box.innerHTML = sepBlockHtml(r);
    });
  }
  document.getElementById("tMore")?.addEventListener("click", () => { LS.set("pel_time_more", !more); renderStatsTiming(body, list); });
  wireTips(body);
}

function renderStatsCal(body: HTMLElement, list: Trade[]) {
  body.innerHTML = '<div class="vh" style="margin-top:0">Calendar &mdash; by day (click a day to filter)</div>' +
    '<div class="calhead"><button id="calPrev" aria-label="Previous month">&lsaquo;</button><b id="calLbl"></b><button id="calNext" aria-label="Next month">&rsaquo;</button></div>' +
    '<div class="cal" id="calGrid"></div>';
  if (!calMonth) {
    const newest = list[0] && list[0].dateTime ? list[0].dateTime.slice(0, 7) : null;
    calMonth = newest || todayLocal().slice(0, 7);
  }
  renderCalendar(list);
  $("calPrev").addEventListener("click", () => { calMonth = shiftMonth(calMonth!, -1); renderCalendar(filtered()); });
  $("calNext").addEventListener("click", () => { calMonth = shiftMonth(calMonth!, 1); renderCalendar(filtered()); });
}

// a round gridline step giving roughly `n` lines over `range`
function niceStep(range: number, n: number): number {
  const raw = Math.max(range, 1e-9) / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}
function drawEquity(list: Trade[]) {
  const cv = document.getElementById("cEquity") as HTMLCanvasElement | null;
  if (!cv) return;
  const g = fit(cv), ctx = g.ctx, W = g.w, H = g.h, pL = 42, pR = 12, pT = 12, pB = 26;
  ctx.clearRect(0, 0, W, H);
  // Resolved AND carrying a risk basis - the contract statsDeep states ("the
  // equity curve, drawdown, SQN, histogram and rolling window skip the
  // sign-guess trades") and this chart was breaking: it summed raw tradeR, so a
  // P&L-only import drew a confident R curve out of computeRraw's ±1 sign
  // guesses while the tile beside it said "0 carry an R basis". A $5 win and a
  // $5,000 win are both +1R on that curve, which is not an equity curve.
  const arr = list.filter((t) => isResolved(t) && hasRBasis(t)).sort((a, b) => (a.dateTime || "").localeCompare(b.dateTime || ""));
  if (!arr.length) {
    ctx.fillStyle = css("--muted"); ctx.font = "11px " + css("--mono"); ctx.textAlign = "center";
    ctx.fillText("no trades with a measurable R yet", W / 2, H / 2);
    return;
  }
  let cum = 0;
  const pts = [0];
  arr.forEach((t) => { cum += tradeR(t); pts.push(cum); });
  let mn = Math.min(...pts), mx = Math.max(...pts);
  if (mx - mn < 1) { mx += 1; mn -= 1; }
  const X = (i: number) => pL + (pts.length < 2 ? 0 : i / (pts.length - 1)) * (W - pL - pR);
  const Y = (v: number) => pT + (1 - (v - mn) / (mx - mn)) * (H - pT - pB);
  // gridlines + R scale, so a value can be read off the curve
  const stp = niceStep(mx - mn, 4);
  ctx.font = "10px " + css("--mono"); ctx.textAlign = "right"; ctx.lineWidth = 1;
  for (let v = Math.ceil(mn / stp) * stp; v <= mx + 1e-9; v += stp) {
    const y = Y(v);
    ctx.strokeStyle = css("--line"); ctx.beginPath(); ctx.moveTo(pL, y); ctx.lineTo(W - pR, y); ctx.stroke();
    ctx.fillStyle = css("--muted"); ctx.fillText((v > 0 ? "+" : "") + (Math.round(v * 10) / 10) + "R", pL - 5, y + 3);
  }
  const zy = Y(0);
  ctx.strokeStyle = css("--line-strong"); ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(pL, zy); ctx.lineTo(W - pR, zy); ctx.stroke(); ctx.setLineDash([]);
  // drawdowns: the gap between the running peak and the curve, shaded
  ctx.fillStyle = css("--stop"); ctx.globalAlpha = 0.16; ctx.beginPath();
  let pk = pts[0];
  const peaks = pts.map((v) => (pk = Math.max(pk, v)));
  peaks.forEach((v, i) => { const x = X(i), y = Y(v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(X(i), Y(pts[i]));
  ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
  // dates under the curve: first, middle, last trade
  ctx.fillStyle = css("--muted"); ctx.font = "10px " + css("--mono");
  const dAt = (i: number) => (arr[Math.max(0, Math.min(arr.length - 1, i - 1))].dateTime || "").slice(0, 10);
  if (arr.length > 1) {
    ctx.textAlign = "left"; ctx.fillText(dAt(1), pL, H - 8);
    ctx.textAlign = "center"; ctx.fillText(dAt(Math.round(pts.length / 2)), (pL + W - pR) / 2, H - 8);
    ctx.textAlign = "right"; ctx.fillText(dAt(pts.length - 1), W - pR, H - 8);
  }
  ctx.strokeStyle = cum >= 0 ? css("--go") : css("--stop"); ctx.lineWidth = 2.4; ctx.beginPath();
  pts.forEach((v, i) => { const x = X(i), y = Y(v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
  ctx.fillStyle = css("--ink"); ctx.beginPath(); ctx.arc(X(pts.length - 1), Y(cum), 3.5, 0, 7); ctx.fill();
  ctx.textAlign = "left";
  ctx.fillStyle = cum >= 0 ? css("--go-ink") : css("--stop-ink");
  ctx.font = "700 11px " + css("--mono");
  ctx.fillText((cum >= 0 ? "+" : "") + cum.toFixed(1) + "R", pL + 4, pT + 9);
  cv.classList.add("tippable");
  chartTip(cv, (x, _y, w) => {
    if (pts.length < 2) return null;
    const i = Math.round(((x - pL) / Math.max(1, w - pL - pR)) * (pts.length - 1));
    if (i < 0 || i >= pts.length) return null;
    const t = i > 0 ? arr[i - 1] : null;
    return (i === 0 ? "start" : "after trade " + i + (t && t.dateTime ? " &middot; " + t.dateTime.slice(0, 10) : "")) +
      "<br><b>" + (pts[i] >= 0 ? "+" : "") + pts[i].toFixed(2) + "R</b>" +
      (t ? " (" + (tradeR(t) >= 0 ? "+" : "") + tradeR(t).toFixed(2) + "R this trade)" : "");
  });
}
function drawRdist(rs: number[]) {
  const cv = document.getElementById("cRdist") as HTMLCanvasElement | null;
  if (!cv) return;
  const g = fit(cv), ctx = g.ctx, W = g.w, H = g.h, pL = 30, pR = 8, pT = 10, pB = 20;
  ctx.clearRect(0, 0, W, H);
  if (!rs.length) {
    // a blank box reads as a rendering fault; say what is missing
    ctx.fillStyle = css("--muted"); ctx.font = "11px " + css("--mono"); ctx.textAlign = "center";
    ctx.fillText("no trades with a measurable R yet", W / 2, H / 2);
    return;
  }
  const lo = -5, hi = 5, step = 0.5, nb = (hi - lo) / step;
  const counts = new Array(nb).fill(0) as number[];
  rs.forEach((r) => { const c = Math.max(lo, Math.min(hi - 0.001, r)); counts[Math.floor((c - lo) / step)]++; });
  const cmax = Math.max(...counts) || 1, bw = (W - pL - pR) / nb;
  // trade-count scale on the left, so a bar's height is a number
  const cs = Math.max(1, niceStep(cmax, 4));
  ctx.font = "10px " + css("--mono"); ctx.textAlign = "right"; ctx.lineWidth = 1;
  for (let c = cs; c <= cmax + 1e-9; c += cs) {
    const y = H - pB - (c / cmax) * (H - pT - pB);
    ctx.strokeStyle = css("--line"); ctx.beginPath(); ctx.moveTo(pL, y); ctx.lineTo(W - pR, y); ctx.stroke();
    ctx.fillStyle = css("--muted"); ctx.fillText(String(Math.round(c)), pL - 5, y + 3);
  }
  for (let i = 0; i < nb; i++) {
    const mid = lo + (i + 0.5) * step, bh = (counts[i] / cmax) * (H - pT - pB);
    ctx.fillStyle = mid > 0.0001 ? css("--go") : mid < -0.0001 ? css("--stop") : css("--muted");
    if (counts[i]) ctx.fillRect(pL + i * bw + 1, H - pB - bh, bw - 2, bh);
  }
  const zx = pL + ((0 - lo) / (hi - lo)) * (W - pL - pR);
  ctx.strokeStyle = css("--line-strong"); ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(zx, pT); ctx.lineTo(zx, H - pB); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = css("--muted"); ctx.font = "10px " + css("--mono"); ctx.textAlign = "center";
  for (let v = -4; v <= 4; v += 2) ctx.fillText(v === 0 ? "0" : (v > 0 ? "+" : "") + v + "R", pL + ((v - lo) / (hi - lo)) * (W - pL - pR), H - 6);
  cv.classList.add("tippable");
  chartTip(cv, (x, _y, w) => {
    const i = Math.floor(((x - pL) / Math.max(1, w - pL - pR)) * nb);
    if (i < 0 || i >= nb || !counts[i]) return null;
    const a = lo + i * step, b = a + step;
    return a.toFixed(1) + "R to " + b.toFixed(1) + "R<br><b>" + counts[i] + " trade" + (counts[i] > 1 ? "s" : "") + "</b> (" + Math.round((counts[i] / rs.length) * 100) + "%)";
  });
}
function drawRolling(list: Trade[]) {
  const cv = document.getElementById("cRolling") as HTMLCanvasElement | null;
  if (!cv) return;
  // same population as the equity curve and statsDeep: a rolling expectancy
  // over fabricated ±1R sign-guesses is a rolling expectancy of nothing
  const res = list.filter((t) => isResolved(t) && hasRBasis(t)).sort((a, b) => (a.dateTime || "").localeCompare(b.dateTime || ""));
  const rs = res.map(tradeR).filter((r) => isFinite(r));
  const g = fit(cv), ctx = g.ctx, W = g.w, H = g.h, pL = 42, pR = 12, pT = 10, pB = 18;
  ctx.clearRect(0, 0, W, H);
  if (rs.length < 8) {
    ctx.fillStyle = css("--muted"); ctx.font = "11px " + css("--mono"); ctx.textAlign = "center";
    ctx.fillText("needs 8+ resolved trades (" + rs.length + " so far)", W / 2, H / 2);
    return;
  }
  // The window must be small enough to leave a LINE, not a single point: at
  // win === rs.length there is exactly one datum and the chart drew empty.
  // Aim for ~a third of the sample, capped at 30 and floored at 4.
  const win = Math.max(4, Math.min(30, Math.round(rs.length / 3)));
  const roll: number[] = [];
  let sum = 0;
  for (let i = 0; i < rs.length; i++) {
    sum += rs[i];
    if (i >= win) sum -= rs[i - win];
    if (i >= win - 1) roll.push(sum / win);
  }
  let mn = Math.min(0, ...roll), mx = Math.max(0, ...roll);
  const pad = Math.max(0.05, (mx - mn) * 0.15);
  mn -= pad; mx += pad;
  const X = (i: number) => pL + (roll.length < 2 ? 0 : i / (roll.length - 1)) * (W - pL - pR);
  const Y = (v: number) => pT + (1 - (v - mn) / (mx - mn)) * (H - pT - pB);
  const zy = Y(0);
  ctx.strokeStyle = css("--line-strong"); ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(pL, zy); ctx.lineTo(W - pR, zy); ctx.stroke(); ctx.setLineDash([]);
  const last = roll[roll.length - 1];
  ctx.strokeStyle = last >= 0 ? css("--go") : css("--stop"); ctx.lineWidth = 2.2; ctx.beginPath();
  roll.forEach((v, i) => { const x = X(i), y = Y(v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
  ctx.fillStyle = css("--muted"); ctx.font = "10px " + css("--mono"); ctx.textAlign = "right";
  ctx.fillText(mx.toFixed(2), pL - 4, pT + 8);
  ctx.fillText(mn.toFixed(2), pL - 4, H - pB);
  ctx.textAlign = "left";
  ctx.fillStyle = last >= 0 ? css("--go-ink") : css("--stop-ink");
  ctx.font = "700 11px " + css("--mono");
  ctx.fillText("now " + (last >= 0 ? "+" : "") + last.toFixed(2) + "R", pL + 4, pT + 9);
  // say which window this actually is, since it adapts to the sample size
  ctx.fillStyle = css("--muted"); ctx.font = "10px " + css("--mono"); ctx.textAlign = "right";
  ctx.fillText(win + "-trade window", W - pR - 2, pT + 8);
  cv.classList.add("tippable");
  chartTip(cv, (x, _y, w) => {
    const i = Math.round(((x - pL) / Math.max(1, w - pL - pR)) * (roll.length - 1));
    if (i < 0 || i >= roll.length) return null;
    const t = res[i + win - 1];
    return "trades " + (i + 1) + "&ndash;" + (i + win) + (t && t.dateTime ? " &middot; to " + t.dateTime.slice(0, 10) : "") +
      "<br><b>" + (roll[i] >= 0 ? "+" : "") + roll[i].toFixed(2) + "R</b> avg per trade";
  });
}
// exit management: how much of the available move you actually keep
// ---------- WHAT TARGET SHOULD THIS BE? ----------
//
// The question a fixed-target trader actually has, and the one the rest of this
// app could not answer: "I take 1.5R every time and I keep watching it run to
// 4R - what should the target be?"
//
// WHY IT IS ANSWERABLE AT ALL. Under a mechanical stop at 1R and a target at T,
// a trade is a winner if and only if the move reached T before it came back to
// the stop. That is one number per trade - `runR` - and it makes the sweep exact
// arithmetic rather than a path simulation. No ordering has to be guessed,
// because the stop IS the terminating condition of the measurement.
//
// AND WHY THE LOSERS NEED NOTHING LOGGED. A trade that lost under a target of P
// proves its run fell short of P. So at any T >= P it is still a loss, derivably,
// from the record as it already stands. That is also the FLOOR: below the target
// you were actually using, this record cannot say what would have happened - a
// trade that ran to 1.2R and reversed is written down only as a loss - and the
// panel refuses that half rather than guessing it.
export interface TargetPoint { t: number; wins: number; n: number; wr: number; exp: number }

// The population: resolved, risk-basis trades that carry a planned target, so
// "it lost" is a statement about a target and not about a discretionary exit.
interface SweepRow { p: number; won: boolean; run: number }
function sweepPop(list: Trade[]): { rows: SweepRow[]; floor: number; short: number; nWon: number } {
  const rows: SweepRow[] = [];
  let floor = Infinity, short = 0, nWon = 0;
  list.filter((t) => isResolved(t) && hasRBasis(t)).forEach((t) => {
    const p = plannedRR(t);
    if (p == null || !isFinite(p) || p <= 0) return;    // no target, no statement
    // THE LOWEST target anyone actually traded, not the highest.
    //
    // This read `max` and it made the panel useless on a mixed record: one trade
    // planned at 4R dragged the floor to 4R and hid everything between. The
    // reason max looked right is real but narrower than it seemed - a LOSER
    // planned at 4R proves the run fell short of 4R and says nothing about
    // whether 2R was reachable, so it cannot be counted as a loss at 2R. The fix
    // is not to raise the floor for everyone, it is to leave that trade OUT of
    // the 2R column. Which target each trade was aiming at is kept per row and
    // the sweep filters on it, so a 1.5R habit sweeps from 1.5R whatever else is
    // in the book.
    if (p < floor) floor = p;
    const r = tradeR(t);
    if (r > 0) {
      // A winner's run is at least what it actually PAID, never what it was
      // aiming at. Those are the same number on a mechanical exit, and using the
      // target looked equivalent - until a mistyped plan made them disagree. Put
      // 4R in the planned box on a record that exits at 1.5R and the old line
      // credited every winner with reaching a 4R target it never saw, then
      // reported 45% of trades hitting 4R and +1.25R a trade. All of it invented,
      // from one wrong field. The realised R is a measurement; the plan is an
      // intention, and an intention is not evidence that price got there.
      const base = r;
      const run = hasNum(t.runR) && Number(t.runR) > base ? Number(t.runR) : base;
      rows.push({ p, won: true, run });
      nWon++;
      if (r < p - 0.05) short++;   // exited before the target it claims to have
    } else if (r < 0) rows.push({ p, won: false, run: 0 });
    // a 0R scratch is neither - it did not reach the target and it did not pay
    // the stop, so it belongs to no arm of this question (Trap #16)
  });
  return { rows, floor: isFinite(floor) ? floor : 0, short, nWon };
}

export function targetSweep(list: Trade[], hi = 8, step = 0.25): { pts: TargetPoint[]; floor: number; nRun: number; nWon: number; short: number; mixed: boolean } {
  const { rows, floor, short, nWon } = sweepPop(list);
  const pts: TargetPoint[] = [];
  if (!rows.length || !(floor > 0)) return { pts, floor, nRun: 0, nWon, short, mixed: false };
  const lo = Math.floor((floor + 1e-9) / step) * step;
  for (let t = Math.max(step, lo); t <= hi + 1e-9; t += step) {
    // Only trades that were AIMING at t or lower can speak about t. A loser
    // planned at 4R proves nothing about 2R, so it is out of the 2R column
    // rather than counted there as a loss - that would be inventing a verdict
    // for a trade whose target was never tested at this level.
    let wins = 0, n = 0;
    for (const row of rows) {
      if (row.p > t + 1e-9) continue;
      n++;
      if (row.won && row.run >= t - 1e-9) wins++;
    }
    if (!n) continue;
    pts.push({ t: +t.toFixed(4), wins, n, wr: wins / n, exp: (wins * t - (n - wins) * 1) / n });
  }
  const nRun = list.filter((t) => hasNum(t.runR) && tradeR(t) > 0).length;
  // more than one target in the book means n grows across the sweep, and a curve
  // whose population changes under it has to say so
  const mixed = pts.length > 1 && pts[pts.length - 1].n !== pts[0].n;
  return { pts, floor, nRun, nWon, short, mixed };
}

// Below this many logged runs the sweep refuses, and the reason is sharper than
// "thin sample". With NO runs logged every winner's run is taken as exactly its
// own target, so the curve peaks at the target you already use - a fabricated
// confirmation of the status quo, which is the worst possible failure mode for
// this particular panel. It must not draw a curve out of the absence of data.
const SWEEP_MIN_RUNS = 20;

// Backfill: one target typed once, rather than opening thirty trades.
//
// SCOPE IS THE ACCOUNT, not the log filter. Every other panel reads filtered();
// this one writes, and a bulk write keyed to a filter someone set to look at
// three trades is how a record gets quietly rewritten. It also only ever fills a
// trade that has NO planned R:R at all - typed or derived from its prices - so
// running it twice is harmless and it can never overwrite a real answer.
function rrMissing(): Trade[] {
  return scoped().filter((t) => isResolved(t) && hasRBasis(t) && plannedRR(t) == null);
}
function rrTyped(): Trade[] {
  return scoped().filter((t) => isResolved(t) && hasRBasis(t) && hasNum(t.rrR));
}
function rrBackfillHtml(): string {
  const miss = rrMissing(), typed = rrTyped();
  if (!miss.length && !typed.length) return "";
  const one = miss.length === 1;
  let body = "";
  if (miss.length) {
    body += "<p><b>" + miss.length + "</b> trade" + (one ? "" : "s") + " with no planned R:R.</p>";
  } else {
    body += "<p>All trades have a planned R:R.</p>";
  }
  // REPLACE IS A SEPARATE, LOUDER BUTTON. Filling a blank cannot lose anything;
  // overwriting a value someone entered can, so it never rides along with the
  // safe action and it never happens without saying how many it will change.
  const acts = '<p class="plan-act"><input type="number" id="rrFillV" class="numin rrfill" step="any" inputmode="decimal" placeholder="1.5" aria-label="Planned R:R to set"> ' +
    (miss.length ? '<button class="btn" id="rrFill">Set on ' + miss.length + " with none</button> " : "") +
    (typed.length ? '<button class="btn danger" id="rrReplace">Replace on all ' + (miss.length + typed.length) + "</button>" : "") +
    "</p>";
  return '<div class="note"><p class="h">Planned R:R across this account</p>' + body + acts +
    "</div>";
}
function wireRrFill() {
  const apply = (targets: Trade[], v: number, verb: string) => {
    targets.forEach((t) => { t.rrR = v; });
    Store.persistAll(JT, JMETA, () => {
      renderJournal();
      toast(verb + " on " + targets.length + " trade" + (targets.length === 1 ? "" : "s") + ".");
    });
  };
  const readV = (): number | null => {
    const v = Number(($i("rrFillV") as HTMLInputElement).value);
    if (!isFinite(v) || v <= 0) { toast("Type the R:R you were aiming at first, e.g. 1.5."); return null; }
    return v;
  };
  const fill = document.getElementById("rrFill");
  if (fill) fill.addEventListener("click", () => {
    const v = readV(); if (v == null) return;
    const miss = rrMissing();
    if (!miss.length) return;
    ask("Set a planned R:R of <b>" + v.toFixed(2) + "R</b> on <b>" + miss.length + "</b> trade" +
      (miss.length === 1 ? "" : "s") + " in <b>" + esc(ACCT || "this journal") + "</b> that have none?" +
      "<br><br>This says every one of them was aiming at that same target. Trades that already carry an R:R are not touched.", [
      { label: "Cancel", kind: "", value: false },
      { label: "Set on " + miss.length, kind: "primary", value: true },
    ], (yes) => { if (yes) apply(miss, v, "Planned R:R set"); });
  });
  const rep = document.getElementById("rrReplace");
  if (rep) rep.addEventListener("click", () => {
    const v = readV(); if (v == null) return;
    const all = rrMissing().concat(rrTyped());
    if (!all.length) return;
    const over = rrTyped().length;
    ask("Replace the planned R:R with <b>" + v.toFixed(2) + "R</b> on <b>" + all.length + "</b> trade" +
      (all.length === 1 ? "" : "s") + " in <b>" + esc(ACCT || "this journal") + "</b>?<br><br>" +
      "<b>" + over + "</b> of them already carr" + (over === 1 ? "ies" : "y") + " a value and it will be overwritten. " +
      "There is no undo &mdash; <b>Export backup</b> first if you are not certain.", [
      { label: "Cancel", kind: "", value: false },
      { label: "Replace on " + all.length, kind: "danger", value: true },
    ], (yes) => { if (yes) apply(all, v, "Planned R:R replaced"); });
  });
}

function renderTargetSweep(list: Trade[]) {
  const el = document.getElementById("tgtSweep");
  if (!el) return;
  const { pts, floor, nRun, nWon, short, mixed } = targetSweep(list);
  const lead = '';
  if (!pts.length) {
    el.innerHTML = lead + '<div class="note"><p class="h">Nothing to sweep yet</p>' +
      '<p class="nomarg">Add a <b>Planned R:R</b> (or entry, stop and target) to your trades.</p></div>' +
      rrBackfillHtml();
    wireRrFill();
    return;
  }
  // A planned R:R that most winners never actually reached is not a plan, it is a
  // typo - and the likeliest one is putting the MFE in the target box, because
  // that is the number a trader has been staring at. Said before anything else,
  // because every figure underneath is derived from it.
  if (nWon > 0 && short >= Math.max(3, nWon * 0.6)) {
    el.innerHTML = lead + '<div class="note warn"><p class="h">The planned R:R does not match how these trades ended</p>' +
      "<p class=\"nomarg\"><b>" + short + " of " + nWon + "</b> winners paid less than their planned R:R. Check the field isn't holding MFE.</p></div>" + rrBackfillHtml();
    wireRrFill();
    return;
  }
  if (nRun < SWEEP_MIN_RUNS) {
    el.innerHTML = lead + '<div class="note warn"><p class="h">Not enough logged runs to sweep on</p>' +
      "<p>You have <b>" + nRun + "</b> winner" + (nRun === 1 ? "" : "s") + " with a full run logged, out of <b>" + nWon +
      "</b>; this needs <b>" + SWEEP_MIN_RUNS + "</b>.</p>" +
      "</div>" +
      rrBackfillHtml();
    wireRrFill();
    return;
  }
  const cov = nWon > 0 ? nRun / nWon : 0;
  const exps = pts.map((p) => p.exp);
  const pl = profitPlateau(exps, PLATEAU_TOL);
  const pick = pts[pl.pk];
  const loT = pts[pl.lo], hiT = pts[pl.hi];
  const cur = pts[0];   // the sweep starts at the target you are already using

  // A BAND, because a peak picked off ~30 candidate targets on one record is the
  // multiplicity problem this app refuses everywhere else. Resample the outcome
  // vector - runs for winners, 0 for the losers that provably fell short - and
  // re-pick. The spread of the ARGMAX is the honest width of the answer.
  // Rows, not bare runs: each carries the target it was aiming at, and the
  // resample has to honour the same "only trades aiming at t or lower may speak
  // about t" rule the curve itself uses, or the band would be measuring a
  // different question from the point it is a band around.
  const { rows: srows } = sweepPop(list);
  const picks: number[] = [];
  for (let b = 0; b < 200; b++) {
    const rnd = mulberry(4801 + b);
    const draw: SweepRow[] = new Array(srows.length);
    for (let i = 0; i < srows.length; i++) draw[i] = srows[(rnd() * srows.length) | 0];
    let best = pts[0].t, bestE = -Infinity;
    pts.forEach((p) => {
      let w = 0, dn = 0;
      for (const row of draw) {
        if (row.p > p.t + 1e-9) continue;
        dn++;
        if (row.won && row.run >= p.t - 1e-9) w++;
      }
      if (!dn) return;
      const e = (w * p.t - (dn - w) * 1) / dn;
      if (e > bestE) { bestE = e; best = p.t; }
    });
    picks.push(best);
  }
  const band = bandOf(picks, 0.9);

  const scale = Math.max(0.25, Math.ceil(Math.max(...exps.map(Math.abs)) * 4) / 4);
  const show = pts.filter((p, i) => i % 2 === 0 || i === pl.pk);
  let rows = "";
  show.forEach((p) => {
    const on = p.t === pick.t;
    const inPl = p.t >= loT.t - 1e-9 && p.t <= hiT.t + 1e-9;
    rows += "<tr" + (on ? ' class="sweeppick"' : "") + "><td>" + p.t.toFixed(2) + "R" +
      (on ? " &larr;" : "") + "</td><td>" + Math.round(p.wr * 100) + "%</td><td>" + p.wins + " / " + p.n +
      '</td><td class="' + (p.exp > 0.0001 ? "cell-go" : p.exp < -0.0001 ? "cell-stop" : "") + '">' +
      (p.exp >= 0 ? "+" : "") + p.exp.toFixed(2) + "R</td>" +
      '<td class="tw">' + bar(seg(50, Math.max(0.8, Math.min(50, (Math.abs(p.exp) / scale) * 50)),
        p.exp >= 0 ? "var(--go)" : "var(--stop)") + tick(50)) + "</td>" +
      "<td>" + (inPl ? "&bull;" : "") + "</td></tr>";
  });

  const gain = pick.exp - cur.exp;
  el.innerHTML = lead +
    '<div class="statgrid">' +
    tileH("Flat top", loT.t.toFixed(2) + "&ndash;" + hiT.t.toFixed(2) + "R",
      "every target on it pays within 3% of the best &mdash; take the low end, it fills more often") +
    tileH("Where it peaks", pick.t.toFixed(2) + "R",
      "+" + pick.exp.toFixed(2) + "R a trade at " + Math.round(pick.wr * 100) + "% win rate") +
    tileH("Against your " + cur.t.toFixed(2) + "R", (gain >= 0 ? "+" : "") + gain.toFixed(2) + "R",
      "a trade, on this record &mdash; " + cur.wins + " of " + cur.n + " win at " + cur.t.toFixed(2) + "R today") +
    tileH("Re-picked on resamples", band.lo.toFixed(2) + "&ndash;" + band.hi.toFixed(2) + "R",
      "90% of 200 resamples of your own record pick a target in here") +
    "</div>" +
    '<div class="scroll"><table class="breakdown"><thead><tr><th>target</th><th>win%</th><th>hits</th><th>expectancy</th>' +
    '<th class="tw">per trade &plusmn;' + scale.toFixed(2) + "R</th><th>flat top</th></tr></thead><tbody>" +
    rows + "</tbody></table></div>" +
    (cov < 0.8 ? '<p class="small plan-note2"><b class="cell-stop">Runs logged on only ' + Math.round(cov * 100) + "% of winners.</b></p>" : "") +
    (mixed ? '<p class="small muted plan-note2">Mixed targets &mdash; read the <b>hits</b> column.</p>' : "") +
    '<p class="small muted plan-note2">Starts at your lowest planned target, ' + floor.toFixed(2) + "R. Follows the log filter.</p>" +
    rrBackfillHtml();
  wireRrFill();
}

function renderExitEff(list: Trade[]) {
  const el = document.getElementById("exitEff");
  if (!el) return;
  const res = list.filter(isResolved);
  const withMfe: { r: number; mfeR: number }[] = [];
  const heats: number[] = [];
  res.forEach((t) => {
    const ex = excursions(t);
    if (ex.mfeR != null && ex.mfeR > 0) withMfe.push({ r: tradeR(t), mfeR: ex.mfeR });
    if (ex.maeR != null && ex.maeR >= 0) heats.push(ex.maeR);
  });
  // 4 was far too low for what this panel CLAIMS. "Exit efficiency 55% of MFE
  // kept" and "avg MFE +3.80R" read as properties of how you trade; on five
  // trades they are properties of five trades, and an average MFE of +3.80R
  // against an average WIN of +1.70R across the record is not a record-wide
  // figure at all - it is five unusual trades. The other panels here unlock at 8
  // and the sizing surfaces refuse under 30; this sits with the sizing ones,
  // because "you are leaving 45% of every move on the table" is an instruction.
  const EX_MIN = 30;
  if (withMfe.length < EX_MIN && heats.length < EX_MIN) {
    el.innerHTML = '<div class="vh" style="margin-top:16px">Exit management</div><p class="small muted" style="margin:0 0 8px">Log MFE/MAE on <b>' + EX_MIN + '+</b> trades to measure how much of each move you keep and how much heat you sit through &mdash; you have <b>' + Math.max(withMfe.length, heats.length) + '</b>. Below that these are properties of a handful of trades rather than of how you trade, and this panel issues an instruction, so it waits. The boxes are in <b>Result</b>, so they are there in Quick log too. The <b>In R / In $ / In price</b> switch logs whichever way you work &mdash; In R always; In $ once the trade carries a Risk $; In price once it has an entry and a stop, which means the Full form for those two.</p>';
    return;
  }
  const tiles: [string, string, string?][] = [];
  if (withMfe.length >= 4) {
    let effSum = 0, left = 0, mfeSum = 0;
    withMfe.forEach((x) => { effSum += Math.max(0, Math.min(1.5, x.r / x.mfeR)); left += Math.max(0, x.mfeR - x.r); mfeSum += x.mfeR; });
    tiles.push(["Exit efficiency", Math.round((effSum / withMfe.length) * 100) + '% <span style="font-size:11px;font-weight:400">of MFE kept</span>']);
    // The AVERAGE best point, not the running total. A cumulative "left on the
    // table" grows with the journal whatever the trading is like, so it says more
    // about how long you have been logging than about how you exit - and it has
    // no counterpart on the loss side. An average sits next to Avg heat on the
    // same scale, and against your own average winner. The total is still here,
    // demoted to the line underneath where it reads as context.
    tiles.push(["Avg MFE", "+" + (mfeSum / withMfe.length).toFixed(2) + 'R <span style="font-size:11px;font-weight:400">best point</span>',
      "+" + left.toFixed(1) + "R left on the table across " + withMfe.length + " trades"]);
  }
  if (heats.length >= 4) {
    const avgHeat = heats.reduce((a, b) => a + b, 0) / heats.length;
    const touched = heats.filter((h) => h >= 0.98).length;
    tiles.push(["Avg heat (MAE)", avgHeat.toFixed(2) + 'R <span style="font-size:11px;font-weight:400">against you</span>']);
    tiles.push(["Full-risk touches", Math.round((touched / heats.length) * 100) + '% <span style="font-size:11px;font-weight:400">came within 2% of the stop</span>']);
  }
  el.innerHTML = '<div class="vh" style="margin-top:16px">Exit management &mdash; from MFE/MAE (' + Math.max(withMfe.length, heats.length) + " trades)</div>" +
    '<div class="statgrid" style="margin-bottom:4px">' + tiles.map((t) => '<div class="tile"><div class="k">' + t[0] + '</div><div class="v" style="font-size:19px">' + t[1] + "</div>" + (t[2] ? '<div class="ts">' + t[2] + "</div>" : "") + "</div>").join("") + "</div>" +
    renderMfeSession(list);
}
// linear-interpolated percentile over a SORTED array
function pctl(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
// ---------- how far trades run, by session ----------
// An average MFE across the whole record hides the thing that actually sets a
// target: the same strategy runs a different distance in a quiet session than in
// a violent one. This is that distribution per session - the middle half of the
// runs as a band, the median as a mark - paired with how much of it you KEPT,
// because a session that runs furthest while you keep the least is a target
// sitting inside the move, not a good session.
interface MfeSess { k: string; n: number; mfes: number[]; heat: number[]; eff: number[] }
function mfeBySession(list: Trade[]): MfeSess[] {
  const g: Record<string, MfeSess> = {};
  list.filter(isResolved).forEach((t) => {
    const ex = excursions(t);
    if (ex.mfeR == null || !(ex.mfeR > 0)) return;   // no run to measure
    const k = sessionOf(t);
    const row = (g[k] = g[k] || { k, n: 0, mfes: [], heat: [], eff: [] });
    row.n++;
    row.mfes.push(ex.mfeR);
    row.eff.push(Math.max(0, Math.min(1.5, tradeR(t) / ex.mfeR)));
    if (ex.maeR != null && ex.maeR >= 0) row.heat.push(ex.maeR);
  });
  const out = SESSIONS.filter((s) => g[s]).map((s) => g[s]);
  out.forEach((r) => r.mfes.sort((a, b) => a - b));
  return out;
}
function renderMfeSession(list: Trade[]): string {
  const rows = mfeBySession(list);
  const solid = rows.filter((r) => r.n >= 4);
  if (!solid.length) return "";
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  // one shared scale, or the bars would each be read against their own maximum
  // and a wide session would look identical to a narrow one
  const cap = Math.max(1, ...rows.map((r) => pctl(r.mfes, 0.9))) * 1.12;
  let html = '<div class="vh" style="margin-top:16px">How far trades run &mdash; by session</div>' +
    '<div class="scroll"><table class="breakdown"><thead><tr><th>Session</th><th>n</th>' +
    // the bars share one scale, so the header names it - a band with no stated
    // maximum is a shape, not a measurement
    '<th style="text-align:left">Typical run (middle half) &middot; 0&ndash;' + cap.toFixed(1) + 'R</th>' +
    "<th>Median</th><th>Best 10%</th><th>Avg heat</th><th>Kept</th></tr></thead><tbody>";
  rows.forEach((r) => {
    const q1 = pctl(r.mfes, 0.25), med = pctl(r.mfes, 0.5), q3 = pctl(r.mfes, 0.75), p90 = pctl(r.mfes, 0.9);
    const X = (v: number) => Math.max(0, Math.min(100, (v / cap) * 100));
    const bar2 = '<div class="tmeter inrow">' + seg(X(q1), Math.max(1.5, X(q3) - X(q1)), "var(--go)", 0.45) +
      tick(X(med), true) + (X(p90) > X(q3) ? tick(X(p90)) : "") + "</div>";
    html += '<tr' + (r.n < 4 ? ' class="thin" title="Only ' + r.n + ' with a logged MFE - too few to read anything into"' : "") + ">" +
      "<td>" + esc(r.k) + "</td><td>" + r.n + '</td><td style="min-width:120px">' + bar2 + "</td>" +
      "<td>" + med.toFixed(2) + "R</td><td>" + p90.toFixed(2) + "R</td>" +
      "<td>" + (r.heat.length ? mean(r.heat).toFixed(2) + "R" : "--") + "</td>" +
      "<td>" + Math.round(mean(r.eff) * 100) + "%</td></tr>";
  });
  html += "</tbody></table></div>";
  return html + '<p class="small muted" style="margin:6px 0 0">Band = middle half &middot; dark mark = median &middot; light mark = best 10%.</p>';
}
function breakdownBy(elId: string, list: Trade[], keyFn: (t: Trade) => string, sortByKey?: boolean) {
  const groups: Record<string, Trade[]> = {};
  list.forEach((t) => { const k = keyFn(t); (groups[k] = groups[k] || []).push(t); });
  const rows = Object.keys(groups).map((k) => { const s = stats(groups[k]); return { k, n: s.n, wr: s.wr, exp: s.exp, r: s.sumR }; });
  if (sortByKey) rows.sort((a, b) => a.k.localeCompare(b.k));
  else rows.sort((a, b) => b.r - a.r);
  let html = '<table class="breakdown"><thead><tr><th>&nbsp;</th><th>n</th><th>win%</th><th>exp</th><th>R</th></tr></thead><tbody>';
  rows.forEach((r) => {
    const cls = r.r > 0.0001 ? "cell-go" : r.r < -0.0001 ? "cell-stop" : "";
    html += '<tr' + (r.n < 4 ? ' class="thin" title="Only ' + r.n + ' trade' + (r.n === 1 ? "" : "s") + ' - too few to read anything into"' : "") + "><td>" + esc(r.k) + "</td><td>" + r.n + "</td><td>" + Math.round(r.wr * 100) + "%</td><td>" + (r.exp >= 0 ? "+" : "") + r.exp.toFixed(2) + '</td><td class="' + cls + '">' + (r.r >= 0 ? "+" : "") + r.r.toFixed(1) + "</td></tr>";
  });
  html += "</tbody></table>";
  $(elId).innerHTML = html;
}
// "By entry model" - the table the model filter is the shortcut for. Its own
// renderer rather than breakdownBy() because RR (avg win / avg loss) is the
// column the whole feature exists for, and rows tick the filter when clicked.
function renderModelTable(elId: string, list: Trade[]) {
  const el = document.getElementById(elId);
  if (!el) return;
  const groups: Record<string, Trade[]> = {};
  list.forEach((t) => { const k = modelOf(t); (groups[k] = groups[k] || []).push(t); });
  const keys = Object.keys(groups);
  if (!keys.filter((k) => k !== "").length) {
    el.innerHTML = '<p class="small muted" style="margin:6px 0 14px">No entry models logged yet.</p>';
    return;
  }
  const rows = keys.map((k) => ({ k, s: stats(groups[k]) })).sort((a, b) => b.s.sumR - a.s.sumR);
  let html = '<table class="breakdown"><thead><tr><th>Entry model</th><th>n</th><th>win%</th><th>RR</th><th>exp</th><th>R</th></tr></thead><tbody>';
  rows.forEach((r) => {
    const rr = payoff(r.s), cls = r.s.sumR > 0.0001 ? "cell-go" : r.s.sumR < -0.0001 ? "cell-stop" : "";
    html += '<tr class="modelrow' + (r.s.n < 4 ? " thin" : "") + '" style="cursor:pointer" title="Filter the log to this model" data-model="' + esc(r.k) +
      '"><td>' + esc(modelLbl(r.k)) + "</td><td>" + r.s.n + "</td><td>" +
      (r.s.n ? Math.round(r.s.wr * 100) + "%" : "--") + "</td><td>" + (rr == null ? "--" : rr.toFixed(2)) + "</td><td>" +
      (r.s.n ? (r.s.exp >= 0 ? "+" : "") + r.s.exp.toFixed(2) : "--") + '</td><td class="' + cls + '">' +
      (r.s.sumR >= 0 ? "+" : "") + r.s.sumR.toFixed(1) + "</td></tr>";
  });
  html += "</tbody></table>";
  el.innerHTML = html;
  el.querySelectorAll<HTMLElement>("tr.modelrow").forEach((tr) =>
    tr.addEventListener("click", () => {
      MODELF.clear();
      MODELF.add(tr.getAttribute("data-model")!);
      setJView("log");
      renderJournal();
    }));
}
// The payout goal set on the Simulator's Funded tab, answered against YOUR
// logged trades instead of the sliders. Deliberately expressed as expected
// payouts rather than a probability: `pay` is derived from the funded profit
// that BOTH the Rust engine and the TS fallback return, so this tile reads the
// same in the desktop app and the browser. A P(hit) would need the payout-count
// distribution, which only the TS side has - and a number that changed with the
// build is worse than a coarser one that does not.
function goalTile(c: OddsView): string {
  const goal = Math.max(0, LS.get<number>("pel_pay_goal", 0));
  if (goal <= 0) return "";
  const { firm } = firmFor();
  // The haircut MUST be applied here, matching payChunk$ on the Simulator's
  // Funded tab. It cancels inside `expect` - it scales the payout total and one
  // payout by the same factor - but NOT inside `need`, whose numerator is a
  // real-dollar goal that was never discounted. Leaving it off made one saved
  // goal cost 22 payouts on one screen and 15 on the other, the gap being
  // exactly 1/(1-haircut).
  const hc = Math.max(0, Math.min(0.5, LS.get<number>("pel_haircut", 0)));
  const chunk$ = (((PAY_CHUNK / 100) * firm.account * firm.split) / 100) * (1 - hc);
  if (!(chunk$ > 0)) return "";
  const expect = (c.pay * (1 - hc)) / chunk$;
  const need = Math.ceil(goal / chunk$);
  const per = LS.get<string>("pel_pay_goal_period", "yr") === "mo";
  const ok = expect >= need;
  return '<div class="tile"><div class="k">Your payout goal</div><div class="v ' + (ok ? "cell-go" : "cell-stop") +
    '" style="font-size:16px">' + (ok ? "on track" : "short") + "</div>" +
    '<div class="ts">' + money(per ? Math.round(goal / 12) : goal) + (per ? "/mo" : "/yr") + " needs <b>" + need +
    "</b> payout" + (need === 1 ? "" : "s") + " &middot; your record averages <b>" + expect.toFixed(1) +
    "</b> a year on this firm. An average over a year, not a monthly wage &mdash; payouts arrive in lumps.</div></div>";
}
function renderPropOdds() {
  const el = document.getElementById("propOdds");
  if (!el) return;
  const c = ensureOdds();
  if (!c) {
    const have = resolvedRs(scoped()).length;
    el.innerHTML = have < 10
      ? '<div class="tile" style="grid-column:1/-1"><div class="k">Locked</div><div class="v" style="font-size:13.5px;font-weight:400">Needs 10 resolved trades (' + have + " so far" + noRNote(scoped()) + ").</div></div>"
      : '<div class="tile" style="grid-column:1/-1"><div class="k">Computing</div><div class="v" style="font-size:13.5px;font-weight:400">Running the Monte Carlo on your trades&hellip;</div></div>';
    return;
  }
  const colv = (x: number) => (x >= 0.85 ? "cell-go" : x >= 0.55 ? "cell-caution" : "cell-stop");
  const rng = (lo: number, hi: number) => '<div class="k" style="margin-top:2px">90% range ' + Math.round(lo * 100) + "&ndash;" + Math.round(hi * 100) + "%</div>";
  const oddsHc = Math.max(0, Math.min(0.5, LS.get<number>("pel_haircut", 0)));
  const payHc = c.pay * (1 - oddsHc);
  const firmName = c.firmDesc;
  const thin = c.n < 50;
  el.innerHTML =
    // an account marked funded is not forecast an evaluation it already passed:
    // the pass leg is history, so it reads as history - the panel used to quote
    // "Pass the eval 62%" one panel below a rule guard saying "(funded)"
    (c.funded
      ? '<div class="tile"><div class="k">Evaluation</div><div class="v cell-go">passed</div><div class="k" style="margin-top:2px">this account is marked funded</div></div>'
      : c.instant
        ? '<div class="tile"><div class="k">Funded on purchase</div><div class="v cell-go">instant</div><div class="k" style="margin-top:2px">no evaluation exists</div></div>'
        : '<div class="tile"><div class="k">Pass the eval' + info("Pass the eval") + '</div><div class="v ' + colv(c.pass) + '">' + pctEst(c.pass) + "</div>" + rng(c.passLo, c.passHi) + "</div>") +
    '<div class="tile"><div class="k">Attempts to fund' + info("Attempts to fund") + '</div><div class="v">' + (c.funded ? "done" : c.att >= 99 ? "many" : c.att.toFixed(1)) + "</div></div>" +
    '<div class="tile"><div class="k">Fees to fund' + info("Fees to fund") + '</div><div class="v">' + (c.funded ? "spent" : money(c.fees)) + '</div><div class="ts">' + c.feesDetail + "</div></div>" +
    '<div class="tile"><div class="k">Stay funded ~1yr' + info("Stay funded ~1yr") + '</div><div class="v ' + colv(c.surv) + '">' + pctEst(c.surv) + "</div>" + rng(c.survLo, c.survHi) + "</div>" +
    // the whole funnel, not just its first gate: passing is the part people quote,
    // getting one withdrawal out is the part that decides whether it was worth buying
    '<div class="tile"><div class="k">Pass &rarr; get paid' + info("Pass &rarr; get paid") + '</div><div class="v ' + colv(c.pass * c.paid) + '">' + Math.round(c.pass * c.paid * 100) + '%</div><div class="ts">one purchase &rarr; cash out &middot; ' +
    Math.round(c.paid * 100) + "% if funded</div></div>" +
    // the haircut slider promises "every payout figure carries it" - this tile
    // and the Portfolio total were the two that silently did not, reading up to
    // 43% higher than the Funded/Decision/Firms figures for the same firm, and
    // grading the tile green on the undiscounted number
    '<div class="tile"><div class="k">Payout if funded' + info("Payout if funded") + '</div><div class="v ' + (payHc - c.fees > 0 ? "cell-go" : "cell-stop") + '">' + money(payHc) + '</div><div class="ts">~1yr, before fees &middot; assumes you get funded' + (oddsHc > 0 ? " &middot; after your " + Math.round(oddsHc * 100) + "% haircut" : "") + "</div></div>" +
    '<div class="tile"><div class="k">Sample quality' + info("Sample quality") + '</div><div class="v ' + (thin ? "cell-caution" : "cell-go") + '" style="font-size:16px">' + c.n + " &middot; " + c.grade + "</div></div>" +
    goalTile(c) +
    '<div class="tile" style="grid-column:1/-1"><div class="k">Basis</div><div class="v" style="font-size:12.5px;font-weight:400">' + c.n + " resolved trades from <b>" + esc(ACCT === "" ? "all accounts" : ACCT) + "</b> resampled against " + esc(firmName) +
    (c.bound ? " (bound)" : " (Simulator firm)") +
    " &middot; eval " + c.re.toFixed(2) + "% &middot; funded " + c.rf.toFixed(2) + "%" + (thin ? " &middot; <b>under 50 trades: ranges wide</b>" : "") + "</div></div>";
  // this panel re-renders on its own when the Monte Carlo lands, so it rewires
  // its own tips rather than relying on the one pass renderStatsPerf makes
  wireTips(el);
}
// The account's trading days, oldest first, over the same population every other
// R statistic runs over (resolved AND carrying a risk basis - Trap #2). Undated
// rows are excluded rather than heaped into one giant pseudo-day, which would
// have made the consistency reading look far worse than the record is.
function dayRs(list: Trade[]): DayR[] {
  const by: Record<string, number> = {};
  list.filter((t) => isResolved(t) && hasRBasis(t)).forEach((t) => {
    const d = (t.dateTime || "").slice(0, 10);
    if (d.length !== 10) return;
    by[d] = (by[d] || 0) + tradeR(t);
  });
  return Object.keys(by).sort().map((d) => ({ day: d, r: by[d] }));
}

function renderEdgeReport(list: Trade[]) {
  const el = document.getElementById("edgeReport");
  if (!el) return;
  const res = list.filter(isResolved);
  if (res.length < 8) {
    el.innerHTML = '<div class="empty-state" style="padding:18px"><p style="margin:0">Needs 8+ resolved, tagged trades.</p></div>';
    return;
  }
  interface Seg { group: string; label: string; n: number; exp: number; sumR: number; wr: number }
  const segs: Seg[] = [];
  const seg = (group: string, label: string, sub: Trade[]) => {
    if (sub.length >= 4) { const s = stats(sub); segs.push({ group, label, n: s.n, exp: s.exp, sumR: s.sumR, wr: s.wr }); }
  };
  CONDITIONS.forEach((c) => seg("Regime", c, res.filter((t) => t.tags && (t.tags.condition || []).indexOf(c) >= 0)));
  QUALITY.forEach((q) => seg("Grade", q, res.filter((t) => t.tags && t.tags.quality === q)));
  SESSIONS.forEach((sn) => seg("Session", sn, res.filter((t) => sessionOf(t) === sn)));
  // keys come from the list under review, not the whole scope, so a filtered
  // report never advertises a model that has no rows in it
  const mods: Record<string, 1> = {};
  res.forEach((t) => { const k = modelOf(t); if (k) mods[k] = 1; });
  Object.keys(mods).forEach((k) => seg("Entry model", k, res.filter((t) => modelOf(t) === k)));
  seg("Direction", "Long", res.filter((t) => t.direction === "long"));
  seg("Direction", "Short", res.filter((t) => t.direction === "short"));
  const syms: Record<string, 1> = {};
  res.forEach((t) => { if (t.instrument) syms[t.instrument] = 1; });
  Object.keys(syms).forEach((sy) => seg("Instrument", sy, res.filter((t) => t.instrument === sy)));
  seg("Emotion", "Calm entry (1-2)", res.filter((t) => t.emotionBefore >= 1 && t.emotionBefore <= 2));
  seg("Emotion", "Elevated entry (4-5)", res.filter((t) => t.emotionBefore >= 4));
  seg("Discipline", "Followed plan", res.filter((t) => t.followedPlan));
  seg("Discipline", "Broke plan", res.filter((t) => t.followedPlan === false));
  const clean = res.filter((t) => !t.tags || !(t.tags.mistake || []).length);
  const dirty = res.filter((t) => t.tags && (t.tags.mistake || []).length > 0);
  seg("Discipline", "Clean (no mistakes)", clean);
  MISTAKES.forEach((m) => seg("Mistake", m, res.filter((t) => t.tags && (t.tags.mistake || []).indexOf(m) >= 0)));
  const strengths = segs.filter((s) => s.exp >= 0.05 && s.group !== "Mistake").sort((a, b) => b.sumR - a.sumR).slice(0, 5);
  const leaks = segs.filter((s) => s.exp <= -0.05 || (s.group === "Mistake" && s.sumR < 0)).sort((a, b) => a.sumR - b.sumR).slice(0, 5);
  const row = (s: Seg, neg: boolean) =>
    '<tr class="segrow" style="cursor:pointer" title="Show these trades" data-group="' + esc(s.group) + '" data-label="' + esc(s.label) + '"><td>' + esc(s.group) + " &middot; " + esc(s.label) + "</td><td>" + s.n + "</td><td>" + Math.round(s.wr * 100) + "%</td><td>" + (s.exp >= 0 ? "+" : "") + s.exp.toFixed(2) + '</td><td class="' + (neg ? "cell-stop" : "cell-go") + '">' + fmtR(s.sumR) + "</td></tr>";
  const head = "<thead><tr><th>&nbsp;</th><th>n</th><th>win%</th><th>exp</th><th>R</th></tr></thead>";
  let disc = "";
  if (dirty.length >= 3 && clean.length >= 3) {
    const ds = stats(dirty), cs = stats(clean);
    disc = '<div class="note ' + (ds.sumR < 0 ? "warn" : "") + '" style="margin:0 0 14px"><p class="h">Discipline check</p><p style="margin:0">Clean trades: <b>' + fmtR(cs.sumR) + "</b> over " + clean.length + " &middot; trades with a tagged mistake: <b>" + fmtR(ds.sumR) + "</b> over " + dirty.length + "." + "</p></div>";
  }
  el.innerHTML = disc + '<div class="chartgrid">' +
    '<div><div class="vh" style="margin-top:0">Strengths &mdash; lean in</div><div class="scroll"><table class="breakdown">' + head + "<tbody>" + (strengths.map((s) => row(s, false)).join("") || '<tr><td colspan="5" class="muted">nothing with n&ge;4 and positive expectancy yet</td></tr>') + "</tbody></table></div></div>" +
    '<div><div class="vh" style="margin-top:0">Leaks &mdash; cut these</div><div class="scroll"><table class="breakdown">' + head + "<tbody>" + (leaks.map((s) => row(s, true)).join("") || '<tr><td colspan="5" class="muted">no measurable leaks with n&ge;4 &mdash; keep logging</td></tr>') + "</tbody></table></div></div></div>";
  el.querySelectorAll<HTMLElement>("tr.segrow").forEach((r) =>
    r.addEventListener("click", () => {
      SEGF = { group: r.getAttribute("data-group")!, label: r.getAttribute("data-label")! };
      setJView("log");
      renderJournal();
    }));
}
// ---------- long vs short ----------
// Direction already appears as one row in the strengths/leaks table, which tells
// you a side is bleeding but never why. This is the why: the two sides put side
// by side on the same scale, each broken into the win half and the loss half.
interface SideS {
  n: number; rn: number; wins: number; losses: number; scr: number; wr: number; exp: number; sumR: number;
  pf: number; avgWin: number; avgLoss: number; best: number; worst: number;
  maxW: number; maxL: number; winDur: number | null; lossDur: number | null;
  grossWin: number; grossLoss: number;
}
function sideStats(list: Trade[]): SideS {
  const s = stats(list), d = statsDeep(list);
  const durOf = (sub: Trade[]) => {
    const ds = sub.map(durationMin).filter((m): m is number => m != null);
    return ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : null;
  };
  const res = list.filter(isResolved);
  // d.rs is already "resolved AND carrying a risk basis", the same population
  // every other R statistic runs over, so the two gross figures reconcile with
  // Total R and their ratio is exactly the profit factor beside them
  let gw = 0, gl = 0;
  d.rs.forEach((r) => { if (r > 0) gw += r; else gl -= r; });
  return {
    n: s.n, rn: s.rn, wins: s.wins, losses: s.losses, scr: s.scr, wr: s.wr, exp: s.exp, sumR: s.sumR,
    pf: s.pf, avgWin: s.avgWin, avgLoss: s.avgLoss, best: s.best, worst: s.worst,
    maxW: d.maxW, maxL: d.maxL,
    winDur: durOf(res.filter((t) => tradeR(t) > 0.0001)),
    lossDur: durOf(res.filter((t) => tradeR(t) < -0.0001)),
    grossWin: gw, grossLoss: gl,
  };
}
function lsRow(label: string, value: string, cls?: string): string {
  return '<div class="lsr"><span class="l">' + label + '</span><span class="n' + (cls ? " " + cls : "") + '">' + value + "</span></div>";
}
function renderLongShort(list: Trade[]) {
  const el = document.getElementById("longShort");
  if (!el) return;
  const res = list.filter(isResolved);
  if (!res.length) { el.innerHTML = '<p class="small muted" style="margin:6px 0 0">No resolved trades in this filter yet.</p>'; return; }
  const longs = res.filter((t) => t.direction === "long");
  const shorts = res.filter((t) => t.direction === "short");
  if (LSIDE === "long" && !longs.length) LSIDE = "all";
  if (LSIDE === "short" && !shorts.length) LSIDE = "all";
  const pick = LSIDE === "long" ? longs : LSIDE === "short" ? shorts : res;
  const s = sideStats(pick);
  const hasR = s.rn > 0;
  const decided = s.wins + s.losses;
  const share = decided ? s.wins / decided : 0;
  const dur = (m: number | null) => (m == null ? "--" : fmtDur(m));
  // the typographic minus, matching the tile grid - an ASCII hyphen next to a
  // "&minus;" two rows down reads as two different kinds of number
  const rr = (v: number) => (v >= 0 ? "+" : "&minus;") + Math.abs(v).toFixed(2) + "R";

  const tabs: [string, string, number][] = [["all", "All", res.length], ["long", "Long", longs.length], ["short", "Short", shorts.length]];
  let html = '<div class="lswrap"><div class="lshead">' +
    '<span class="lst">Long vs short' + info("Long vs short") + "</span>" +
    '<div class="seg" role="group" aria-label="Direction">' +
    tabs.map(([k, lbl, n]) => '<button type="button" data-ls="' + k + '" aria-pressed="' + (LSIDE === k) + '"' +
      (n ? "" : " disabled") + ">" + lbl + " " + n + "</button>").join("") + "</div></div>";

  // the dial + the two stat columns, for whichever side is open
  html += '<div class="lsbody"><div class="lsdial"><div class="dk">' +
    (LSIDE === "all" ? "All trades" : LSIDE === "long" ? "Long trades" : "Short trades") + '</div><div class="dv">' + s.n + "</div>" +
    // the dial's scale is 0-100% of decided trades, notched at the 50% mark; the
    // measured value is spelled out underneath rather than pinned to the notch
    gauge(share, "0%", "50%", "100%", Math.round(share * 100) + "% of decided trades won") +
    '<div class="ds">' + (decided ? "<b>" + Math.round(share * 100) + "%</b> of " + decided + " decided trades won" : "no decided trades") +
    (s.scr ? " &middot; " + s.scr + " scratched" : "") +
    (hasR ? "<br>" + (s.sumR >= 0 ? "+" : "") + s.sumR.toFixed(1) + "R total &middot; PF " + (s.pf >= 99 ? "no losers" : s.pf.toFixed(2)) : "") + "</div></div>";

  html += '<div class="lscol"><div class="ch"><i style="background:var(--go)"></i>Win statistics</div>' +
    lsRow("Winners", String(s.wins)) +
    lsRow("Best win", hasR && s.wins ? rr(s.best) : "--", "cell-go") +
    lsRow("Average win", hasR && s.wins ? rr(s.avgWin) : "--", "cell-go") +
    lsRow("Avg win held", dur(s.winDur)) +
    lsRow("Longest win run", String(s.maxW)) +
    lsRow("Gross wins", hasR ? "+" + s.grossWin.toFixed(1) + "R" : "--", "cell-go") + "</div>";

  html += '<div class="lscol"><div class="ch"><i style="background:var(--stop)"></i>Loss statistics</div>' +
    lsRow("Losers", String(s.losses)) +
    lsRow("Worst loss", hasR && s.losses ? rr(s.worst) : "--", "cell-stop") +
    lsRow("Average loss", hasR && s.losses ? "&minus;" + s.avgLoss.toFixed(2) + "R" : "--", "cell-stop") +
    lsRow("Avg loss held", dur(s.lossDur)) +
    lsRow("Longest loss run", String(s.maxL)) +
    lsRow("Gross losses", hasR ? "&minus;" + s.grossLoss.toFixed(1) + "R" : "--", "cell-stop") + "</div></div>";

  // ---- the comparison proper: both sides, one scale per metric ----
  html += '<div class="vscmp">';
  if (!longs.length || !shorts.length) {
    html += '<p class="small muted" style="margin:0">Every resolved trade in this filter is ' +
      (longs.length ? "<b>long</b>" : "<b>short</b>") + " &mdash; there is no other side to compare it against yet.</p>";
  } else {
    const ls = sideStats(longs), ss = sideStats(shorts);
    // fixedMax exists for win rate: a percentage read against the OTHER side's
    // percentage turns 69 vs 12 into a bar five times longer, which is a ratio
    // nobody meant. It gets its own absolute 0-100 scale instead.
    const vsRow = (k: string, a: number, b: number, fmt: (v: number) => string, zeroCentred: boolean, fixedMax?: number) => {
      const mx = fixedMax || Math.max(Math.abs(a), Math.abs(b), 1e-9);
      const line = (lbl: string, v: number) => {
        // a zero-centred metric fills out from the middle so a negative side is
        // unmistakably a bar pointing the other way, not just a red bar
        const w = (Math.abs(v) / mx) * (zeroCentred ? 50 : 100);
        const left = zeroCentred ? (v >= 0 ? 50 : 50 - w) : 0;
        const c = v > 0.0001 ? "var(--go)" : v < -0.0001 ? "var(--stop)" : "var(--line-strong)";
        return '<div class="vsline"><span class="sl">' + lbl + '</span><div class="vstrack">' +
          '<i style="left:' + left.toFixed(1) + "%;width:" + Math.max(w, 0.8).toFixed(1) + "%;background:" + c + '"></i>' +
          (zeroCentred ? '<span class="zt" style="left:50%"></span>' : "") + '</div><span class="sv">' + fmt(v) + "</span></div>";
      };
      return '<div class="vsrow"><div class="vk">' + k + "</div>" + line("Long", a) + line("Short", b) + "</div>";
    };
    html += vsRow("Total R", ls.sumR, ss.sumR, (v) => (v >= 0 ? "+" : "&minus;") + Math.abs(v).toFixed(1) + "R", true);
    html += vsRow("Expectancy per trade", ls.exp, ss.exp, (v) => (v >= 0 ? "+" : "&minus;") + Math.abs(v).toFixed(2) + "R", true);
    html += vsRow("Win rate (0&ndash;100% scale)", ls.wr * 100, ss.wr * 100, (v) => Math.round(v) + "%", false, 100);
    if (ls.n < 8 || ss.n < 8) html += '<p class="small" style="margin:8px 0 0;color:var(--muted)">Under 8 trades on a side.</p>';
  }
  html += "</div></div>";
  el.innerHTML = html;
  el.querySelectorAll<HTMLButtonElement>("button[data-ls]").forEach((b) =>
    b.addEventListener("click", () => {
      LSIDE = b.getAttribute("data-ls")!;
      LS.set("pel_ls_side", LSIDE);
      renderLongShort(list);
    }));
  wireTips(el);
}

// ---------- session map ----------
// The same numbers as the "By session" table underneath, drawn as a shape. The
// radial axis is TOTAL R with the zero circle drawn on it, so a losing session
// falls inside the ring instead of being flattened to a small positive spoke.
interface SessRow { k: string; n: number; r: number; wr: number; exp: number }
function sessionRows(list: Trade[]): SessRow[] {
  const res = list.filter(isResolved);
  return SESSIONS.filter((s) => res.some((t) => sessionOf(t) === s)).map((k) => {
    const s = stats(res.filter((t) => sessionOf(t) === k));
    return { k, n: s.n, r: s.sumR, wr: s.wr, exp: s.exp };
  });
}
function drawSessions(rows: SessRow[]) {
  const cv = document.getElementById("cSess") as HTMLCanvasElement | null;
  if (!cv) return;
  const g = fit(cv), ctx = g.ctx, W = g.w, H = g.h;
  ctx.clearRect(0, 0, W, H);
  if (rows.length < 3) {
    ctx.fillStyle = css("--muted"); ctx.font = "11px " + css("--mono"); ctx.textAlign = "center";
    ctx.fillText(rows.length ? "needs trades in 3+ sessions to draw a shape" : "no sessions logged yet", W / 2, H / 2);
    return;
  }
  // room on all four sides for a two-line axis label, and a floor under the
  // radius so the smallest session is a short spoke rather than a pile-up on the
  // centre point (which also collapsed the zero ring into a dot)
  const cx = W / 2, cy = H / 2, R = Math.max(28, Math.min(W / 2 - 76, H / 2 - 36)), R0 = R * 0.18;
  const vals = rows.map((r) => r.r);
  let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  if (hi - lo < 0.5) { hi += 0.5; lo -= 0.5; }
  const N = rows.length, ang = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / N;
  const rad = (v: number) => R0 + ((v - lo) / (hi - lo)) * (R - R0);
  const px = (i: number, r: number) => [cx + Math.cos(ang(i)) * r, cy + Math.sin(ang(i)) * r];
  const poly = (r: (i: number) => number) => {
    ctx.beginPath();
    for (let i = 0; i < N; i++) { const [x, y] = px(i, r(i)); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.closePath();
  };
  // web + spokes
  ctx.strokeStyle = css("--line"); ctx.lineWidth = 1;
  [0.25, 0.5, 0.75, 1].forEach((f) => { poly(() => R * f); ctx.stroke(); });
  for (let i = 0; i < N; i++) {
    const [x, y] = px(i, R);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
  }
  // the zero ring - everything inside it lost money
  const z = rad(0);
  ctx.strokeStyle = css("--line-strong"); ctx.lineWidth = 1.4; ctx.setLineDash([3, 3]);
  poly(() => z); ctx.stroke(); ctx.setLineDash([]);
  // the record itself
  const tot = vals.reduce((a, b) => a + b, 0);
  const col = tot >= 0 ? css("--go") : css("--stop");
  poly((i) => rad(rows[i].r));
  ctx.globalAlpha = 0.22; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
  ctx.strokeStyle = col; ctx.lineWidth = 2.2; ctx.stroke();
  ctx.fillStyle = col;
  for (let i = 0; i < N; i++) { const [x, y] = px(i, rad(rows[i].r)); ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill(); }
  // labels sit outside the web. Name always above its number, in every position,
  // so the eye reads them in one order - and the top axis gets its two lines
  // placed DOWNWARD from the rim, or the number lands off the top of the canvas.
  ctx.font = "10px " + css("--mono");
  ctx.textBaseline = "alphabetic";
  for (let i = 0; i < N; i++) {
    const a = ang(i), [x, y] = px(i, R + 8);
    const vert = Math.abs(Math.cos(a)) < 0.3;
    ctx.textAlign = vert ? "center" : Math.cos(a) > 0 ? "left" : "right";
    const ny = vert ? (Math.sin(a) < 0 ? y - 10 : y + 9) : y - 2;
    ctx.fillStyle = css("--ink");
    ctx.fillText(rows[i].k, x, ny);
    ctx.fillStyle = rows[i].r > 0.0001 ? css("--go-ink") : rows[i].r < -0.0001 ? css("--stop-ink") : css("--muted");
    ctx.fillText((rows[i].r >= 0 ? "+" : "") + rows[i].r.toFixed(1) + "R" + (rows[i].n < 4 ? " (n=" + rows[i].n + ")" : ""), x, ny + 11);
  }
  ctx.fillStyle = css("--muted"); ctx.font = "9px " + css("--mono"); ctx.textAlign = "left";
  ctx.fillText("dashed ring = 0R", 6, 12);
  cv.classList.add("tippable");
  chartTip(cv, (x, y) => {
    const dx = x - cx, dy = y - cy, d = Math.sqrt(dx * dx + dy * dy);
    if (d > R + 22) return null;
    let a = Math.atan2(dy, dx) + Math.PI / 2;
    while (a < 0) a += 2 * Math.PI;
    const i = Math.round((a / (2 * Math.PI)) * N) % N;
    const r = rows[i];
    return esc(r.k) + "<br><b>" + (r.r >= 0 ? "+" : "") + r.r.toFixed(2) + "R</b> over " + r.n + " trade" + (r.n === 1 ? "" : "s") +
      " &middot; " + Math.round(r.wr * 100) + "% win";
  });
}
function renderSessionMap(list: Trade[]) {
  const rows = sessionRows(list);
  drawSessions(rows);
  const bw = document.getElementById("sessBW");
  if (!bw) return;
  // The session is the label YOU tag on the trade, never anything inferred from
  // the timestamp - which is the only way it can be right for a trader whose
  // clock is nowhere near the market's. It stays honest in any timezone.
  // Untagged rows are counted under Other. Say how many, so a big Other spoke is
  // never mistaken for a real finding about trades taken outside the majors.
  const untagged = list.filter(isResolved).filter((t) => !t.session).length;
  // "predate the required Session field" was a false explanation for most of
  // these rows: the app's own CSV importer wrote session:"" until 2.7.x, so the
  // rows it created minutes ago were being blamed on history. Name both causes;
  // the importer can no longer mint new ones.
  const note = untagged ? '<p class="small muted" style="margin:7px 0 0;font-size:11.5px"><b>' + untagged + "</b> untagged &mdash; counted as Other.</p>" : "";
  // a one-trade session is not the "worst session", it is one trade. Ranking
  // needs the same n>=4 floor the edge report holds everything else to.
  const rank = rows.filter((r) => r.n >= 4).sort((a, b) => b.r - a.r);
  if (rank.length < 2) { bw.innerHTML = note; return; }
  const best = rank[0], worst = rank[rank.length - 1];
  const thin = rows.length - rank.length;
  const box = (k: string, r: SessRow, cls: string) =>
    '<div class="sbx"><div class="k">' + k + '</div><div class="v">' + esc(r.k) +
    ' <span class="' + cls + '">' + (r.r >= 0 ? "+" : "") + r.r.toFixed(1) + 'R</span></div><div class="s">' +
    r.n + " trade" + (r.n === 1 ? "" : "s") + " &middot; " + Math.round(r.wr * 100) + "% win &middot; " +
    (r.exp >= 0 ? "+" : "") + r.exp.toFixed(2) + "R each</div></div>";
  bw.innerHTML = '<div class="sessbw">' + box("Best session", best, best.r >= 0 ? "cell-go" : "cell-stop") +
    box("Worst session", worst, worst.r >= 0 ? "cell-go" : "cell-stop") + "</div>" +
    (thin ? '<p class="small muted" style="margin:7px 0 0;font-size:11.5px">Ranked over sessions with 4+ trades; ' + thin + " thinner " + (thin === 1 ? "one is" : "ones are") + " on the chart but not in the ranking.</p>" : "") + note;
}
function renderCalendar(list: Trade[]) {
  const grid = document.getElementById("calGrid");
  if (!grid || !calMonth) return;
  const ym = calMonth, y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  $("calLbl").textContent = new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  // both units are always accumulated; JUNIT only decides what is shown and
  // which one drives the heat shading
  // dollars come from the shared resolver, not t.pnl: reading the raw field made
  // every R-only day render as a flat $0 cell with no heat, which in $ mode is a
  // month that looks like it was never traded
  const byDay: Record<string, { r: number; d: number; dn: number }> = {};
  list.forEach((t) => {
    if (!t.dateTime) return;
    const d = t.dateTime.slice(0, 10);
    if (d.slice(0, 7) !== ym) return;
    const cell = byDay[d] || (byDay[d] = { r: 0, d: 0, dn: 0 });
    cell.r += tradeR(t);
    const d$ = trade$(t);
    if (d$ != null) { cell.d += d$; cell.dn++; }
  });
  // tint must agree with the number printed on the cell: "both" shows R first,
  // so R drives the colour there as well - a green +0.8R on a red cell is worse
  // than no colour at all.
  // an unpriced day has no dollar heat to show, so it falls back to R rather
  // than tinting itself neutral off a $0 that was never measured
  const heatOf = (c: { r: number; d: number; dn: number }) => (unitNow() === "$" && c.dn ? c.d : c.r);
  let maxAbs = 0.0001;
  Object.keys(byDay).forEach((k) => { maxAbs = Math.max(maxAbs, Math.abs(heatOf(byDay[k]))); });
  const first = new Date(y, m - 1, 1).getDay(), dim = new Date(y, m, 0).getDate();
  let html = "";
  ["S", "M", "T", "W", "T", "F", "S"].forEach((d) => { html += '<div class="d dow">' + d + "</div>"; });
  for (let i = 0; i < first; i++) html += '<div class="d off"></div>';
  const sign = (v: number) => (v >= 0 ? "+" : "");
  for (let day = 1; day <= dim; day++) {
    const ds = ym + "-" + pad2(day);
    const cell = byDay[ds];
    let style = "", cls = "d", val = "";
    if (cell != null) {
      cls += " has";
      const h = heatOf(cell);
      const a = Math.min(0.85, 0.18 + (Math.abs(h) / maxAbs) * 0.6);
      // a tint layer over the panel colour: same result as color-mix() but without
      // its Safari 16.2 floor, which silently dropped the whole heat map on older Macs
      const t = tint(h >= 0 ? "--go" : "--stop", a);
      style = "background-color:var(--panel);background-image:linear-gradient(" + t + "," + t + ");";
      const rTxt = sign(cell.r) + cell.r.toFixed(1) + "R";
      const dTxt = cell.dn ? sign(cell.d) + Math.round(cell.d) : "--";
      const U = unitNow();
      val = U === "R" ? '<span class="p">' + rTxt + "</span>"
        : U === "$" ? '<span class="p">' + dTxt + "</span>"
          : '<span class="p">' + rTxt + '</span><span class="p2">' + dTxt + "</span>";
    }
    html += '<div class="' + cls + '" ' + (cell != null ? 'data-day="' + ds + '" title="Filter to ' + ds + '"' : "") + ' style="' + style + '"><span class="n">' + day + "</span>" + val + "</div>";
  }
  grid.innerHTML = html;
  grid.querySelectorAll<HTMLElement>(".d.has").forEach((d) =>
    d.addEventListener("click", () => {
      $i("fltFrom").value = d.getAttribute("data-day")!;
      $i("fltTo").value = d.getAttribute("data-day")!;
      setJView("log");
      renderJournal();
    }));
}
function shiftMonth(ym: string, delta: number): string {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1 + delta;
  const d = new Date(y, m, 1);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1);
}
function pad2(n: number): string { return n < 10 ? "0" + n : String(n); }
// resolve a theme colour var to rgba() at a given alpha
function tint(varName: string, alpha: number): string {
  const raw = css(varName).trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(raw);
  if (!m) return raw;
  const n = parseInt(m[1], 16);
  return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + alpha.toFixed(3) + ")";
}
function todayLocal(): string {
  const d = new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}
// ---------- the setup / entry-model combobox ----------
//
// These two were <input list=...> + <datalist>, and a datalist popup is drawn by
// the BROWSER: proportional font, its own row height, its own background, and no
// author CSS reaches any of it. Sitting in the same grid as the themed <select>s
// for session, account and direction, it read as a different application.
//
// So it is rebuilt here, in the app's own vocabulary. The INPUT UNDERNEATH IS
// STILL A PLAIN TEXT INPUT and is read by exactly the same $i("edSetup").value
// the editor always read - the list is a shortcut for what you have typed
// before, never a constraint on what you may type. A setup you have never used
// is the normal case for a trader trying something new, and a control that made
// that harder than picking from history would be the wrong trade.
const comboOpts: Record<string, string[]> = { edSetup: [], edModel: [] };
function comboSet(id: string, values: string[]) {
  comboOpts[id] = values;
  // an open popup showing a list that has just changed underneath is worse than
  // one that closed, so it repaints against the box's current text
  const pop = document.getElementById(id === "edSetup" ? "cbSetupPop" : "cbModelPop");
  if (pop && !pop.hidden) comboPaint(id);
}
let comboActive = -1;
function comboPop(id: string): HTMLElement | null {
  return document.getElementById(id === "edSetup" ? "cbSetupPop" : "cbModelPop");
}
function comboMatches(id: string): string[] {
  const el = document.getElementById(id) as HTMLInputElement | null;
  const q = (el ? el.value : "").trim().toLowerCase();
  const all = comboOpts[id] || [];
  if (!q) return all;
  // typed-substring, not prefix: "sweep" should find "Liq sweep + CHOCH", which
  // is how these names are actually shaped
  return all.filter((v) => v.toLowerCase().indexOf(q) >= 0);
}
function comboPaint(id: string) {
  const pop = comboPop(id);
  if (!pop) return;
  const rows = comboMatches(id);
  if (!rows.length) {
    pop.innerHTML = '<div class="cbnone">' +
      ((comboOpts[id] || []).length ? "Nothing you have used before matches &mdash; what you type is kept as it is."
        : "Nothing logged under this yet. Type one and it joins the list.") + "</div>";
    comboActive = -1;
    return;
  }
  if (comboActive >= rows.length) comboActive = rows.length - 1;
  pop.innerHTML = rows.map((v, i) =>
    '<button type="button" class="cbopt' + (i === comboActive ? " on" : "") + '" role="option" aria-selected="' +
    (i === comboActive ? "true" : "false") + '" data-v="' + esc(v) + '">' + esc(v) + "</button>").join("");
  pop.querySelectorAll<HTMLButtonElement>(".cbopt").forEach((b) => {
    // mousedown, not click: the input's blur fires first on a click and would
    // close the popup out from under the pointer
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      comboPick(id, b.getAttribute("data-v") || "");
    });
  });
}
function comboOpen(id: string) {
  const pop = comboPop(id), el = document.getElementById(id);
  if (!pop || !el) return;
  comboActive = -1;
  comboPaint(id);
  pop.hidden = false;
  el.setAttribute("aria-expanded", "true");
}
function comboClose(id: string) {
  const pop = comboPop(id), el = document.getElementById(id);
  if (pop) pop.hidden = true;
  if (el) el.setAttribute("aria-expanded", "false");
  comboActive = -1;
}
function comboPick(id: string, v: string) {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el) return;
  el.value = v;
  // the editor's own listeners (the dirty flag, the required-field marker) hang
  // off `input`, and setting .value does not fire it
  el.dispatchEvent(new Event("input", { bubbles: true }));
  comboClose(id);
  el.focus();
}
function comboMove(id: string, d: number) {
  const rows = comboMatches(id);
  if (!rows.length) return;
  const pop = comboPop(id);
  if (pop && pop.hidden) { comboOpen(id); return; }
  comboActive = (comboActive + d + rows.length + 1) % (rows.length + 1);
  // the extra slot is "none of them" - arrowing past the end returns you to what
  // you actually typed rather than wrapping straight onto the first row again
  if (comboActive === rows.length) comboActive = -1;
  comboPaint(id);
  const on = pop?.querySelector(".cbopt.on") as HTMLElement | null;
  if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
}
function wireCombo(id: string, togId: string) {
  const el = document.getElementById(id) as HTMLInputElement | null;
  const tog = document.getElementById(togId);
  if (!el || !tog) return;
  el.addEventListener("focus", () => comboOpen(id));
  el.addEventListener("input", () => { comboActive = -1; comboOpen(id); });
  el.addEventListener("blur", () => { setTimeout(() => comboClose(id), 120); });
  el.addEventListener("keydown", (e) => {
    const pop = comboPop(id);
    if (e.key === "ArrowDown") { e.preventDefault(); comboMove(id, 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); comboMove(id, -1); }
    else if (e.key === "Escape") {
      // Escape closes the LIST first and the whole editor second - a half-typed
      // trade thrown away because the suggestion list happened to be open is the
      // kind of thing nobody reports and everybody resents
      if (pop && !pop.hidden) { e.stopPropagation(); comboClose(id); }
    } else if (e.key === "Enter") {
      const rows = comboMatches(id);
      if (pop && !pop.hidden && comboActive >= 0 && comboActive < rows.length) {
        e.preventDefault();
        comboPick(id, rows[comboActive]);
      } else comboClose(id);
    } else if (e.key === "Tab") comboClose(id);
  });
  tog.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const pop = comboPop(id);
    if (pop && !pop.hidden) comboClose(id);
    else { el.focus(); comboOpen(id); }
  });
}

function refreshSetups() {
  const set: Record<string, 1> = {};
  scoped().forEach((t) => { if (t.setup) set[t.setup] = 1; });
  const keys = Object.keys(set).sort();
  comboSet("edSetup", keys);
  const sel = $s("fltSetup"), cur = sel.value;
  sel.innerHTML = '<option value="">All setups</option>' + keys.map((k) => '<option value="' + esc(k) + '">' + esc(k) + "</option>").join("");
  if (keys.indexOf(cur) >= 0) sel.value = cur;
  refreshModels();
}

// realized reward:risk - average winner divided by average loser, in R. This is
// the "RR" that pairs with win rate: wr x rr - (1-wr) is the expectancy.
function payoff(s: Stats): number | null {
  if (!s.wins || !s.losses || s.avgLoss <= 0) return null;
  return s.avgWin / s.avgLoss;
}
// Entry-model filter: tick one or more models and the log, the stats and this
// readout all narrow to them. Rebuilt whenever the trade set or scope changes.
function refreshModels() {
  const keys = modelKeys();
  const named = keys.filter((k) => k !== "");
  comboSet("edModel", named.slice().sort());
  // a model that no longer exists in scope must not keep filtering invisibly
  [...MODELF].forEach((k) => { if (keys.indexOf(k) < 0) MODELF.delete(k); });
  const box = $("fltModelBox");
  if (!named.length) {
    box.innerHTML = '<p class="small muted" style="margin:0">Add one on a trade &mdash; the field is in the quick log.</p>';
    $("fltModelHint").textContent = "";
    $("fltModelStat").textContent = "";
    return;
  }
  // the chips are rebuilt on every render, so remember which one had focus -
  // otherwise toggling with the keyboard drops you back to the top of the page
  const act = document.activeElement as HTMLElement | null;
  const hadFocus = act && box.contains(act) ? act.getAttribute("data-model") : null;
  box.innerHTML = keys.map((k) =>
    '<button type="button" class="opt" data-model="' + esc(k) + '" aria-pressed="' + MODELF.has(k) + '">' + esc(modelLbl(k)) + "</button>").join("") +
    // unticking six models one by one to get back to "all" is not a workflow
    (MODELF.size ? '<button type="button" class="opt" id="fltModelClear" title="Untick every model">&times; clear</button>' : "");
  box.querySelectorAll<HTMLButtonElement>(".opt[data-model]").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.getAttribute("data-model")!;
      if (MODELF.has(k)) MODELF.delete(k); else MODELF.add(k);
      renderJournal();
    }));
  document.getElementById("fltModelClear")?.addEventListener("click", () => { MODELF.clear(); renderJournal(); });
  if (hadFocus != null) {
    // matched by comparison, not a selector: a model name can contain quotes
    box.querySelectorAll<HTMLButtonElement>(".opt[data-model]").forEach((b) => { if (b.getAttribute("data-model") === hadFocus) b.focus(); });
  }
  $("fltModelHint").textContent = MODELF.size ? "(" + MODELF.size + " ticked)" : "";
  renderModelStat();
}
// the answer to "what is the win rate and RR of this model?", right under the ticks
function renderModelStat() {
  const el = document.getElementById("fltModelStat");
  if (!el) return;
  if (!MODELF.size) {
    el.innerHTML = "";
    return;
  }
  // filtered(), not just the model slice: the readout must describe the trades
  // actually on screen, or it disagrees with the summary tiles above it
  const sub = filtered();
  const s = stats(sub);
  if (!s.n) {
    el.innerHTML = "<b>" + sub.length + "</b> trade" + (sub.length === 1 ? "" : "s") + ", none resolved yet" + noRNote(sub) + ".";
    return;
  }
  const rr = payoff(s);
  const cls = s.exp > 0.0001 ? "cell-go" : s.exp < -0.0001 ? "cell-stop" : "";
  el.innerHTML =
    "<b>" + s.n + "</b> resolved &middot; win <b>" + Math.round(s.wr * 100) + "%</b> &middot; RR <b>" +
    (rr == null ? "&mdash;" : rr.toFixed(2)) + "</b><br>exp <b class='" + cls + "'>" + (s.exp >= 0 ? "+" : "") + s.exp.toFixed(2) +
    "R</b> &middot; total " + (s.sumR >= 0 ? "+" : "") + s.sumR.toFixed(1) + "R" +
    (s.n < 8 ? "<br><span class='muted'>Thin sample &mdash; read it as a hint, not a verdict.</span>" : "") +
    "<br><span class='muted'>RR = avg win &divide; avg loss, in R.</span>";
}

// ---------- editor ----------
function chipset(elId: string, opts: string[], cls: string) {
  const el = $(elId);
  el.innerHTML = opts.map((o) => '<button type="button" class="opt ' + cls + '" data-v="' + esc(o) + '" aria-pressed="false">' + esc(o) + "</button>").join("");
  el.querySelectorAll<HTMLButtonElement>(".opt").forEach((b) =>
    b.addEventListener("click", () => {
      if (cls === "q" && b.getAttribute("aria-pressed") !== "true")
        el.querySelectorAll(".opt").forEach((x) => x.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true");
    }));
}
function chipsGet(elId: string): string[] {
  const out: string[] = [];
  $(elId).querySelectorAll('.opt[aria-pressed="true"]').forEach((b) => out.push(b.getAttribute("data-v")!));
  return out;
}
function chipsSet(elId: string, vals: string[]) {
  vals = vals || [];
  $(elId).querySelectorAll(".opt").forEach((b) => b.setAttribute("aria-pressed", vals.indexOf(b.getAttribute("data-v")!) >= 0 ? "true" : "false"));
}
function emorow(elId: string) {
  const el = $(elId);
  el.innerHTML = "";
  for (let i = 1; i <= 5; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = String(i);
    b.setAttribute("data-v", String(i));
    b.setAttribute("aria-pressed", "false");
    el.appendChild(b);
  }
  el.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      const was = b.getAttribute("aria-pressed") === "true";
      el.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", "false"));
      if (!was) b.setAttribute("aria-pressed", "true");
    }));
}
function emoGet(elId: string): number {
  const b = $(elId).querySelector('button[aria-pressed="true"]');
  return b ? Number(b.getAttribute("data-v")) : 0;
}
function emoSet(elId: string, v: number) {
  $(elId).querySelectorAll("button").forEach((b) =>
    b.setAttribute("aria-pressed", Number(b.getAttribute("data-v")) === v && v > 0 ? "true" : "false"));
}
function planGet(): boolean {
  const b = document.querySelector('.seg button[data-plan][aria-pressed="true"]');
  return b ? b.getAttribute("data-plan") === "1" : true;
}
function planSet(v: boolean) {
  document.querySelectorAll<HTMLButtonElement>(".seg button[data-plan]").forEach((b) =>
    b.setAttribute("aria-pressed", (b.getAttribute("data-plan") === "1") === !!v ? "true" : "false"));
}
function symKnown(v: string): boolean {
  for (const g in INSTRUMENTS) if (INSTRUMENTS[g].indexOf(v) >= 0) return true;
  return false;
}
function setSymUI(v: string) {
  if (!v) { $s("edSymSel").value = ""; $("edSymCustomWrap").classList.add("hide"); $i("edSym").value = ""; }
  else if (symKnown(v)) { $s("edSymSel").value = v; $("edSymCustomWrap").classList.add("hide"); $i("edSym").value = ""; }
  else { $s("edSymSel").value = "__custom"; $("edSymCustomWrap").classList.remove("hide"); $i("edSym").value = v; }
}
function getSymUI(): string {
  const s = $s("edSymSel").value;
  return s === "__custom" ? $i("edSym").value.trim() : s;
}
function renderFormThumbs() {
  const el = $("edThumbs");
  el.innerHTML = "";
  formImages.forEach((im, idx) => {
    if (!im.blob) return;   // slot reserved, image still loading
    const d = document.createElement("div");
    d.className = "th";
    if (!im.url && im.blob) im.url = URL.createObjectURL(im.blob);
    d.innerHTML = '<img src="' + im.url + '" alt="screenshot ' + (idx + 1) + '"><button type="button" title="Remove" aria-label="Remove screenshot">&times;</button>';
    d.querySelector("button")!.addEventListener("click", () => { formImages.splice(idx, 1); renderFormThumbs(); });
    el.appendChild(d);
  });
}
function addFiles(files: FileList | File[]) {
  Array.prototype.forEach.call(files, (f: File) => {
    if (!f.type || f.type.indexOf("image") < 0) return;
    downscale(f, (blob, w, h) => {
      // 12 per trade is the cap the backup round-trip enforces (sanitizeTrade
      // slices imports there), so accepting a 13th here was deferred data
      // loss: it looked saved, exported fine, and vanished on the first
      // restore - discoverable only after the originals were gone. Refuse at
      // the door and name the limit instead.
      if (formImages.length >= 12) { toast("12 screenshots per trade is the limit - more would be dropped by a backup restore."); return; }
      formImages.push({ id: "i" + Date.now() + "_" + Math.random().toString(36).slice(2, 7), blob, w, h });
      renderFormThumbs();
    });
  });
}
function priceR(): number | null {
  if ($i("edR").value !== "" && isFinite(Number($i("edR").value))) return Number($i("edR").value);
  const e = $i("edEntry").value, s = $i("edStop").value, x = $i("edExit").value;
  if (hasNum(e) && hasNum(s) && hasNum(x)) {
    const per = Math.abs(Number(e) - Number(s));
    if (per > 0) return ((Number(x) - Number(e)) / per) * ($s("edDir").value === "short" ? -1 : 1);
  }
  return null;
}
// Trades saved before pnlManual existed carry no provenance. If the stored P&L
// is what the auto formula would have produced, it was auto-filled.
function pnlLooksAuto(t: Trade): boolean {
  if (!hasNum(t.pnl) || !hasNum(t.riskAmt) || Number(t.riskAmt) <= 0) return false;
  let r: number | null = null;
  if (t.Rmanual && hasNum(t.R)) r = Number(t.R);
  else if (hasNum(t.entry) && hasNum(t.stop) && hasNum(t.exit)) {
    const per = Math.abs(Number(t.entry) - Number(t.stop));
    if (per > 0) r = ((Number(t.exit) - Number(t.entry)) / per) * (t.direction === "short" ? -1 : 1);
  }
  if (r == null) return false;
  const net = r * Number(t.riskAmt) - (hasNum(t.fees) ? Number(t.fees) : 0);
  return Math.abs(net - Number(t.pnl)) <= Math.max(0.02, Math.abs(net) * 0.005);
}
function autoPnl() {
  const el = $i("edPnl");
  if (el.dataset.manual === "1") return;
  const risk = $i("edRisk").value, fees = $i("edFees").value, r = priceR();
  if (!hasNum(risk) || Number(risk) <= 0 || r == null) {
    if (el.dataset.auto === "1") { el.value = ""; delete el.dataset.auto; }
    return;
  }
  const net = r * Number(risk) - (hasNum(fees) ? Number(fees) : 0);
  el.value = String(Math.round(net * 100) / 100);
  el.dataset.auto = "1";
}
// A hand-typed P&L intentionally outranks the prices, so it is never silently
// overwritten - but when the two disagree the editor says so and offers the swap.
// This is also the way out for trades saved while the old freeze bug was live.
let pnlNoteHtml = "";
function updatePnlNote() {
  const el = $("edPnlNote"), pe = $i("edPnl");
  const risk = $i("edRisk").value, r = priceR();
  const hide = () => { if (pnlNoteHtml !== "") { pnlNoteHtml = ""; el.innerHTML = ""; el.classList.add("hide"); } };
  if (pe.dataset.manual !== "1" || r == null || !hasNum(risk) || Number(risk) <= 0 || !hasNum(pe.value)) { hide(); return; }
  const fees = $i("edFees").value;
  const net = r * Number(risk) - (hasNum(fees) ? Number(fees) : 0);
  const cur = Number(pe.value);
  if (Math.abs(net - cur) <= Math.max(0.02, Math.abs(net) * 0.005)) { hide(); return; }
  const curR = cur / Number(risk), netR = net / Number(risk);
  const html = 'P&amp;L is pinned to a typed value: <b>' + money(cur) + "</b> (" + (curR >= 0 ? "+" : "") + curR.toFixed(2) +
    "R). Your entry, stop and exit say <b>" + money(net) + "</b> (" + (netR >= 0 ? "+" : "") + netR.toFixed(2) +
    'R). <button type="button" class="barbtn" id="edPnlFix" style="margin-left:6px">Use the prices</button>';
  if (html === pnlNoteHtml) return;   // don't rebuild mid-click on every keystroke
  pnlNoteHtml = html;
  el.innerHTML = html;
  el.className = "small cell-caution";
  $("edPnlFix").addEventListener("click", () => {
    delete pe.dataset.manual;
    delete pe.dataset.auto;
    liveR();
  });
}
// ---------- excursion unit (MFE/MAE in R or in price) ----------
// A price MFE is only meaningful next to an entry and a stop: without them
// excursions() has nothing to divide by and the number can never become R. So
// price mode is offered only when that conversion is actually available.
function exPer(): { entry: number; per: number; dir: number } | null {
  const e = num($i("edEntry").value), s = num($i("edStop").value);
  if (e == null || s == null) return null;
  const per = Math.abs(e - s);
  if (!(per > 0)) return null;
  return { entry: e, per, dir: $s("edDir").value === "short" ? -1 : 1 };
}
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
// What 1R is worth in money for the trade CURRENTLY IN THE FORM: the typed Risk
// $, else the selected account's R value. Same order as riskPerR on a saved one.
function exRisk(): number | null {
  const risk = num($i("edRisk").value);
  if (risk != null && risk > 0) return risk;
  const rv = rValue($s("edAcct").value || "Main");
  return rv != null && rv > 0 ? rv : null;
}
const EX_LBL: Record<string, [string, string]> = {
  R: ["MFE (R in favour)", "MAE (R against)"],
  $: ["MFE (best unrealized P&L)", "MAE (worst unrealized P&L)"],
  price: ["MFE (best price)", "MAE (worst price)"],
};
// Every unit converts through R, which is the journal's unit of record - so
// there is one conversion to get right per unit rather than one per PAIR of
// units. null means "this unit cannot be resolved with what the form holds".
function exToR(v: number, unit: string, heat: boolean): number | null {
  if (unit === "R") return heat ? Math.abs(v) : v;
  if (unit === "$") { const rv = exRisk(); return rv == null ? null : (heat ? Math.abs(v) : v) / rv; }
  const c = exPer();
  if (!c) return null;
  return heat ? Math.abs(((c.entry - v) / c.per) * c.dir) : ((v - c.entry) / c.per) * c.dir;
}
function exFromR(r: number, unit: string, heat: boolean): number | null {
  if (unit === "R") return heat ? Math.abs(r) : r;
  if (unit === "$") { const rv = exRisk(); return rv == null ? null : (heat ? Math.abs(r) : r) * rv; }
  const c = exPer();
  if (!c) return null;
  return heat ? c.entry - c.dir * Math.abs(r) * c.per : c.entry + c.dir * r * c.per;
}
function exAvailable(u: string): boolean {
  return u === "R" || (u === "$" ? exRisk() != null : exPer() != null);
}
function updateExUI() {
  const lbl = EX_LBL[EXU] || EX_LBL.R;
  $("edMfeLbl").textContent = lbl[0];
  $("edMaeLbl").textContent = lbl[1];
  document.querySelectorAll<HTMLButtonElement>("button[data-exu]").forEach((b) => {
    const u = b.getAttribute("data-exu")!;
    b.setAttribute("aria-pressed", String(u === EXU));
    // never disable the unit currently in use - a trade stored in prices has to
    // stay editable even if its entry/stop were later cleared
    b.disabled = u !== EXU && !exAvailable(u);
    // a dead button with no reason reads as broken, and in Quick log two of the
    // three were PERMANENTLY dead with nothing saying why: the fields they need
    // (Entry/Stop for price, Risk $ for money) live in sections Quick log
    // hides, so on a fresh quick-logged trade they are unreachable by
    // construction. Name the missing field and, in Quick log, the way out.
    b.title = !b.disabled ? ""
      : (u === "$" ? "Needs a Risk $ on the trade (or an R value on the account)" : "Needs an Entry and a Stop price") +
        (ED_QUICK ? " - switch to the Full form to fill those in" : "");
  });
  const mfe = num($i("edMfeIn").value), mae = num($i("edMaeIn").value);
  const el = $("edExNote");
  const missing = EXU === "$" ? "Money mode needs a Risk $ (or an R value on the account)."
    : EXU === "price" ? "Price mode needs an entry and a stop." : "";
  if (mfe == null && mae == null) {
    const base = EXU === "R" ? "MAE is entered as a positive number." : "";
    el.innerHTML = base + (exAvailable(EXU) ? "" : " <b>" + missing + "</b>");
    return;
  }
  const rMfe = mfe == null ? null : exToR(mfe, EXU, false);
  const rMae = mae == null ? null : exToR(mae, EXU, true);
  if (rMfe == null && rMae == null) {
    el.innerHTML = "These numbers cannot be read as R yet &mdash; <b>" + missing + "</b>";
    return;
  }
  const parts: string[] = [];
  if (rMfe != null) parts.push("<b>" + (rMfe >= 0 ? "+" : "&minus;") + Math.abs(rMfe).toFixed(2) + "R</b> in your favour at best");
  if (rMae != null) parts.push("<b>" + Math.abs(rMae).toFixed(2) + "R</b> of heat against you");
  el.innerHTML = "Reads as " + parts.join(" &middot; ") + ".";
}
// Flipping the unit converts exactly, via R, whenever both the old and the new
// unit can be resolved from the form. When they cannot, the old numbers are
// meaningless in the new unit - so they are cleared and said so, rather than
// reinterpreted as if 4512.5 were suddenly 4512.5R.
function setExUnit(u: string) {
  if (u === EXU) return;
  const mfe = num($i("edMfeIn").value), mae = num($i("edMaeIn").value);
  if (mfe != null || mae != null) {
    const rMfe = mfe == null ? null : exToR(mfe, EXU, false);
    const rMae = mae == null ? null : exToR(mae, EXU, true);
    const outMfe = rMfe == null ? null : exFromR(rMfe, u, false);
    const outMae = rMae == null ? null : exFromR(rMae, u, true);
    if ((mfe != null && outMfe == null) || (mae != null && outMae == null)) {
      $i("edMfeIn").value = ""; $i("edMaeIn").value = "";
      toast("Cleared MFE/MAE — nothing in the form converts those numbers into the new unit.");
    } else {
      if (outMfe != null) $i("edMfeIn").value = String(round6(outMfe));
      if (outMae != null) $i("edMaeIn").value = String(round6(outMae));
    }
  }
  EXU = u;
  LS.set("pel_ex_unit", u);
  updateExUI();
}
function liveR() {
  autoPnl();
  updatePnlNote();
  updateExUI();
  const t: TradeLike = {
    R: $i("edR").value, Rmanual: $i("edR").value !== "", riskAmt: $i("edRisk").value, pnl: $i("edPnl").value,
    entry: $i("edEntry").value, stop: $i("edStop").value, target: $i("edTarget").value, exit: $i("edExit").value,
    direction: $s("edDir").value,
  };
  let r = computeR(t);
  if (!isFinite(r)) r = 0;
  const chip = $("edRchip");
  chip.textContent = (r >= 0 ? "+" : "") + r.toFixed(2) + "R";
  chip.className = "rchip " + (r > 0.0001 ? "win" : r < -0.0001 ? "loss" : "");
  const pr = plannedRR(t), el = $("edPlanRR");
  const edBal = (JMETA.balances || {})[$s("edAcct").value];
  const riskPct = edBal != null && edBal > 0 && hasNum(t.riskAmt) && Number(t.riskAmt) > 0
    ? " &middot; risk " + ((Number(t.riskAmt) / edBal) * 100).toFixed(2) + "% of account" : "";
  const durT: Trade = { dateTime: $i("edDate").value, exitTime: $i("edExitTime").value } as Trade;
  const dm = durationMin(durT);
  const dur = dm != null ? " &middot; held " + fmtDur(dm) : "";
  if (pr != null) {
    const rk = hasNum(t.riskAmt) ? " &middot; reward " + money(pr * Number(t.riskAmt)) : "";
    el.innerHTML = "Planned RR <b class='" + (pr > 0 ? "cell-go" : "cell-stop") + "'>" + (pr >= 0 ? "+" : "") + pr.toFixed(2) + "R</b> from entry/stop/target" + rk + riskPct + dur + (hasNum(t.exit) ? "" : " &mdash; realized R fills in when you add the exit");
  } else if (riskPct || dur) el.innerHTML = "Planned RR shows once entry, stop and target are set" + riskPct + dur + ".";
  else el.textContent = "Planned RR shows here once entry, stop and target are set.";
}
function formSnapshot(): string {
  return JSON.stringify([
    // EXU rides in the snapshot: flipping the unit rewrites which fields the
    // trade will be saved with, so it is an unsaved change like any other
    [EXU].concat(["edDate", "edSymSel", "edSym", "edAcct", "edDir", "edSess", "edSetup", "edModel", "edEntry", "edStop", "edTarget", "edExit", "edSize", "edRisk", "edPnl", "edFees", "edR", "edPlan", "edNotes", "edExitTime", "edMfeIn", "edMaeIn", "edRunIn", "edRrIn"].map((id) => ($(id) as HTMLInputElement).value)),
    chipsGet("edQuality"), chipsGet("edMistakes"), chipsGet("edConditions"),
    emoGet("edEmoB"), emoGet("edEmoA"), planGet(), formImages.map((i) => i.id),
  ]);
}
let edSnap = "";
function edDirty(): boolean { return formSnapshot() !== edSnap; }

// quick log: hide the deep sections for fast capture; values in hidden fields
// still save (collectTrade reads the DOM), so toggling never loses anything
function applyEdMode() {
  // Screenshots stay visible in quick mode: pasting a chart is the point of a
  // quick capture, and hiding the section meant a pasted image had no preview.
  ["secExec", "secTags", "secPsych", "secReview"].forEach((id) => $(id).classList.toggle("hide", ED_QUICK));
  $("secShots").classList.remove("hide");
  $("edModeBtn").textContent = ED_QUICK ? "Full form" : "Quick log";
}

// Put the selected account's R value in the Risk $ box of a NEW trade. Never on
// an existing one - that would silently rewrite what was actually risked.
function prefillRisk() {
  if (EDIT_ID) return;
  const el = $i("edRisk");
  // only fill an empty box, or one this function filled itself
  if (el.value !== "" && el.dataset.auto !== "1") return;
  const rv = rValue($s("edAcct").value || "Main");
  if (rv == null) { if (el.dataset.auto === "1") { el.value = ""; delete el.dataset.auto; } return; }
  el.value = String(Math.round(rv * 100) / 100);
  el.dataset.auto = "1";
}
function fillAcctSel(selected: string) {
  const sel = $s("edAcct");
  sel.innerHTML = "";
  accounts().forEach((a) => { const o = document.createElement("option"); o.value = a; o.textContent = a; sel.appendChild(o); });
  sel.value = accounts().indexOf(selected) >= 0 ? selected : accounts()[0];
}
export function openEditor(id: string | null) {
  EDIT_ID = id;
  formImages = [];
  // a required-field marker from a previous refused save must not greet the next trade
  ["edSymSel", "edSess"].forEach((x) => $(x).classList.remove("needs"));
  $("edTitle").textContent = id ? "Edit trade" : "New trade";
  $("edDelete").style.visibility = id ? "visible" : "hidden";
  const t0 = id ? JT.find((x) => x.id === id) : null;
  fillAcctSel(t0 ? accOf(t0) : (ACCT || accounts()[0]));
  chipsSet("edQuality", []); chipsSet("edMistakes", []); chipsSet("edConditions", []);
  emoSet("edEmoB", 0); emoSet("edEmoA", 0); planSet(true);
  const t = id ? JT.find((x) => x.id === id) : null;
  const nz = (v: unknown) => (v == null || v === "" ? "" : String(v));
  if (t) {
    $i("edDate").value = t.dateTime || "";
    setSymUI(t.instrument || "");
    $s("edDir").value = t.direction || "long";
    $s("edSess").value = t.session || "";
    $i("edSetup").value = t.setup || "";
    $i("edModel").value = t.entryModel || "";
    $i("edEntry").value = nz(t.entry); $i("edStop").value = nz(t.stop); $i("edTarget").value = nz(t.target);
    $i("edExit").value = nz(t.exit); $i("edSize").value = nz(t.size); $i("edRisk").value = nz(t.riskAmt);
    $i("edPnl").value = nz(t.pnl); $i("edFees").value = nz(t.fees);
    $i("edExitTime").value = t.exitTime || "";
    // open on the unit this trade was actually written in; fall back to the
    // remembered preference only when it carries no excursions at all
    EXU = hasNum(t.mfe) || hasNum(t.mae) ? "price"
      : hasNum(t.mfeD) || hasNum(t.maeD) ? "$"
        : hasNum(t.mfeR) || hasNum(t.maeR) ? "R" : EXU;
    $i("edRunIn").value = nz(t.runR);
    $i("edRrIn").value = nz(t.rrR);
    $i("edMfeIn").value = EXU === "price" ? nz(t.mfe) : EXU === "$" ? nz(t.mfeD) : nz(t.mfeR);
    $i("edMaeIn").value = EXU === "price" ? nz(t.mae) : EXU === "$" ? nz(t.maeD) : nz(t.maeR);
    $i("edR").value = t.Rmanual ? String(t.R) : "";
    planSet(!!t.followedPlan);
    $i("edPlan").value = t.planText || ""; $i("edNotes").value = t.notes || "";
    if (t.tags) {
      chipsSet("edQuality", t.tags.quality ? [t.tags.quality] : []);
      chipsSet("edMistakes", t.tags.mistake || []);
      chipsSet("edConditions", t.tags.condition || []);
    }
    emoSet("edEmoB", t.emotionBefore || 0); emoSet("edEmoA", t.emotionAfter || 0);
    // Restore how the P&L got there. Marking every saved P&L as hand-typed
    // froze it: autoPnl() bailed, so editing the exit no longer moved P&L or R.
    const pe = $i("edPnl");
    delete pe.dataset.auto;
    if (pe.value === "") delete pe.dataset.manual;
    else if (t.pnlManual === true) pe.dataset.manual = "1";
    else if (t.pnlManual === false) delete pe.dataset.manual;
    else if (pnlLooksAuto(t)) delete pe.dataset.manual;   // saved before the flag existed
    else pe.dataset.manual = "1";
    // reserve a slot per id first: store reads finish out of order, and pushing
    // on completion scrambled the setup/management/exit sequence on save
    const eids = t.imageIds || [];
    formImages = eids.map((iid) => ({ id: iid, blob: null as unknown as Blob, existing: true }));
    eids.forEach((iid, i) =>
      Store.getImage(iid, (rec) => {
        if (rec && rec.blob) { formImages[i].blob = rec.blob; formImages[i].w = rec.w; formImages[i].h = rec.h; }
        renderFormThumbs();
        // NO re-snapshot here. The snapshot only carries image IDS, and those
        // were reserved synchronously above - a completed load changes nothing
        // the snapshot can see. Re-snapshotting baked whatever the user had
        // typed while the images were still loading into the "clean" baseline,
        // which disarmed the discard prompt exactly while the trade loaded.
      }));
  } else {
    $i("edDate").value = todayLocal();
    ["edSym", "edSetup", "edModel", "edEntry", "edStop", "edTarget", "edExit", "edSize", "edRisk", "edPnl", "edFees", "edR", "edPlan", "edNotes", "edExitTime", "edMfeIn", "edMaeIn", "edRunIn", "edRrIn"].forEach((x) => { ($(x) as HTMLInputElement).value = ""; });
    $s("edDir").value = "long"; $s("edSess").value = "";
    setSymUI("");
    const pe2 = $i("edPnl");
    delete pe2.dataset.manual; delete pe2.dataset.auto;
    // A new trade on an account with a dollar basis starts with that risk in the
    // box, so autoPnl fills P&L and the trade FREEZES its own risk figure. Change
    // the account R value later and history keeps the number it was logged at,
    // which is the honest behaviour: you did not re-risk the old trades.
    prefillRisk();
  }
  renderFormThumbs();
  applyEdMode();
  updateExUI();
  liveR();
  $("editorOv").classList.remove("hide");
  ($("editorOv").querySelector(".sheet-body") as HTMLElement).scrollTop = 0;
  edSnap = formSnapshot();
  $s("edSymSel").focus(); // synchronous: a delayed focus() would yank focus mid-typing (select type-ahead)
}
function closeEditor(force: boolean) {
  if (!force && edDirty()) {
    ask("Discard unsaved changes to this trade?", [
      { label: "Keep editing", kind: "", value: false },
      { label: "Discard", kind: "danger", value: true },
    ], (yes) => { if (yes) { $("editorOv").classList.add("hide"); EDIT_ID = null; formImages = []; } });
    return;
  }
  $("editorOv").classList.add("hide");
  EDIT_ID = null;
  formImages = [];
}
function num(v: string): number | null { return v === "" || v == null ? null : Number(v); }
function collectTrade(): Trade {
  const q = chipsGet("edQuality");
  const manual = $i("edR").value !== "";
  const t: Trade = {
    id: EDIT_ID || "t" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    account: $s("edAcct").value || "Main",
    dateTime: $i("edDate").value, instrument: getSymUI(), direction: $s("edDir").value as "long" | "short",
    session: $s("edSess").value, setup: $i("edSetup").value.trim(),
    entryModel: $i("edModel").value.trim(),
    entry: num($i("edEntry").value), stop: num($i("edStop").value), target: num($i("edTarget").value),
    exit: num($i("edExit").value), size: num($i("edSize").value), riskAmt: num($i("edRisk").value),
    pnl: num($i("edPnl").value), fees: num($i("edFees").value),
    R: manual ? Number($i("edR").value) : null, Rmanual: manual,
    pnlManual: $i("edPnl").dataset.manual === "1",
    followedPlan: planGet(), planText: $i("edPlan").value, notes: $i("edNotes").value,
    tags: { quality: q[0] || "", mistake: chipsGet("edMistakes"), condition: chipsGet("edConditions") },
    emotionBefore: emoGet("edEmoB"), emotionAfter: emoGet("edEmoA"),
    imageIds: formImages.map((im) => im.id),
    exitTime: $i("edExitTime").value || null,
    // exactly ONE unit is stored per trade - the one on screen. Writing both
    // would leave a trade whose two excursion pairs could disagree, resolved by
    // a precedence rule the person logging it never sees.
    mfe: EXU === "price" ? num($i("edMfeIn").value) : null,
    mae: EXU === "price" ? num($i("edMaeIn").value) : null,
    mfeR: EXU === "R" ? num($i("edMfeIn").value) : null,
    maeR: EXU === "R" ? num($i("edMaeIn").value) : null,
    mfeD: EXU === "$" ? num($i("edMfeIn").value) : null,
    maeD: EXU === "$" ? num($i("edMaeIn").value) : null,
    // always in R, whatever the excursion switch says - it is defined AGAINST
    // the stop, so a price or a dollar figure would need converting back into
    // the only unit it means anything in
    runR: num($i("edRunIn").value),
    rrR: num($i("edRrIn").value),
  };
  if (!manual) t.R = computeRraw(t);
  return t;
}
// The write is async (IDB transaction / Tauri invoke) and the Save button stays
// live until its callback fires. A second click in that window ran collectTrade()
// again, minted a fresh id and unshifted a second copy - one impatient
// double-click silently duplicated the trade and skewed every stat.
let SAVING = false;
// Refuse a save and point at the field that caused it. The red border clears the
// moment the field is touched - a marker that stays after it is satisfied is
// just noise, and the listener removes itself with { once: true }.
function needField(id: string, msg: string) {
  const el = $(id) as HTMLInputElement | HTMLSelectElement;
  el.classList.add("needs");
  el.addEventListener("change", () => el.classList.remove("needs"), { once: true });
  el.addEventListener("input", () => el.classList.remove("needs"), { once: true });
  toast(msg);
  el.focus();
}
function saveTrade() {
  if (SAVING) return;
  if (!JLOADED) { toast("Journal is still loading - try again in a second."); return; }
  const t = collectTrade();
  // Instrument and session are required, on the quick log as much as the full
  // form - both live in the Trade section, which quick mode keeps visible. They
  // are the two fields the edge report cannot reconstruct later: a trade saved
  // without them is a row that never appears in an instrument or session
  // breakdown, and nobody goes back to fill them in from memory.
  if (!t.instrument) { needField("edSymSel", "Pick an instrument before saving."); return; }
  if (!t.session) { needField("edSess", "Pick a session before saving — Other is a fine answer."); return; }
  const old = EDIT_ID ? JT.find((x) => x.id === EDIT_ID) : null;
  t.createdAt = old && old.createdAt ? old.createdAt : Date.now();
  const toWrite = formImages.filter((im) => !im.existing);
  const removed = old ? (old.imageIds || []).filter((iid) => t.imageIds.indexOf(iid) < 0) : [];
  SAVING = true;
  const saveBtn = $("edSave") as HTMLButtonElement;
  saveBtn.disabled = true;
  const commit = () => {
    removed.forEach((iid) => { Store.deleteImage(iid); delete urlCache[iid]; });
    t._R = computeR(t);
    if (old) JT = JT.map((x) => (x.id === t.id ? t : x));
    else JT.unshift(t);
    JT.sort((a, b) => (b.dateTime || "").localeCompare(a.dateTime || ""));
    Store.persistAll(JT, JMETA, (okv) => {
      SAVING = false;
      saveBtn.disabled = false;
      if (!okv) toast("Warning: could not write journal.");
      closeEditor(true);
      renderJournal();
      if ($i("useJournal").checked) applyJournalEdge();
      toast(old ? "Trade updated." : "Trade logged.");
    });
  };
  if (!toWrite.length) { commit(); return; }
  let done = 0, fail = 0;
  toWrite.forEach((im) =>
    Store.putImage(im, (okv) => {
      if (!okv) fail++;
      if (++done === toWrite.length) { if (fail) toast(fail + " image(s) failed to save."); commit(); }
    }));
}
// Deleting is undoable. The trades leave the journal (and storage) at once, but
// their screenshot files are only erased when the Undo window closes - so Undo
// restores the trades with every image intact.
function removeTrades(ids: string[], msg: string, after?: () => void) {
  const gone = JT.filter((t) => ids.indexOf(t.id) >= 0);
  JT = JT.filter((t) => ids.indexOf(t.id) < 0);
  Store.persistAll(JT, JMETA, () => {
    if (after) after();
    renderJournal();
    if ($i("useJournal").checked) applyJournalEdge();
    toastAction(msg, "Undo", () => {
      const have = new Set(JT.map((t) => t.id));
      JT = JT.concat(gone.filter((t) => !have.has(t.id)));
      JT.sort((a, b) => (b.dateTime || "").localeCompare(a.dateTime || ""));
      Store.persistAll(JT, JMETA, () => {
        renderJournal();
        if ($i("useJournal").checked) applyJournalEdge();
        toast("Restored " + gone.length + " trade" + (gone.length > 1 ? "s" : "") + ".");
      });
    }, () => {
      gone.forEach((t) => (t.imageIds || []).forEach((iid) => { Store.deleteImage(iid); delete urlCache[iid]; }));
    });
  });
}
function deleteTrade(id: string) {
  const t = JT.find((x) => x.id === id);
  if (!t) return;
  ask("Delete this trade?" + (t.imageIds && t.imageIds.length ? " Its screenshots go with it." : ""), [
    { label: "Cancel", kind: "", value: false },
    { label: "Delete", kind: "danger", value: true },
  ], (yes) => {
    if (!yes) return;
    removeTrades([id], "Trade deleted.", () => {
      $("editorOv").classList.add("hide");
      $("detailOv").classList.add("hide");
      EDIT_ID = null;
    });
  });
}

// ---------- select mode + bulk delete ----------
// The selection you can ACT on is the selection you can SEE. A filter applied
// after ticking rows hides ticked trades but used to leave them in SEL, so the
// button could read "Delete (12)" over a screen showing none of them - and
// confirming really did destroy twelve trades the screen neither showed nor
// named. Counting and deleting the intersection with filtered() makes the
// button, the confirm and the visible log agree; a hidden tick is parked, not
// armed, and reappears when the filter that hid it is lifted.
// ...and "visible" means DRAWN: a trade inside a folded day passes the filter
// but is not on screen, so it can be neither selected nor deleted from here.
function visibleSel(): string[] {
  if (!SEL.size) return [];
  return [...SEL].filter((id) => LOG_SHOWN.has(id));
}
function updateSelUI() {
  const del = $("jDelSel");
  const n = visibleSel().length;
  del.textContent = "Delete (" + n + ")";
  del.classList.toggle("hide", !SELMODE || n === 0);
  $("jSelAll").classList.toggle("hide", !SELMODE);
  $("jSelMode").textContent = SELMODE ? "Cancel" : "Select";
}
function setSelMode(on: boolean) {
  SELMODE = on;
  SEL.clear();
  updateSelUI();
  renderLog();
}
function bulkDelete() {
  const ids = visibleSel();
  if (!ids.length) return;
  const withImgs = JT.filter((t) => ids.indexOf(t.id) >= 0 && t.imageIds && t.imageIds.length).length;
  ask("Delete <b>" + ids.length + "</b> trade" + (ids.length > 1 ? "s" : "") + "?" + (withImgs ? " Screenshots on " + withImgs + " of them go too." : ""), [
    { label: "Cancel", kind: "", value: false },
    { label: "Delete " + ids.length, kind: "danger", value: true },
  ], (yes) => {
    if (!yes) return;
    removeTrades(ids, ids.length + " trade" + (ids.length > 1 ? "s" : "") + " deleted.", () => { SELMODE = false; SEL.clear(); updateSelUI(); });
  });
}

// ---------- account scope ----------
function refreshEdgeAcctSel() {
  const sel = $s("jEdgeAcct");
  sel.innerHTML = "";
  const all = document.createElement("option");
  all.value = ""; all.textContent = "All accounts";
  sel.appendChild(all);
  accounts().forEach((a) => {
    const o = document.createElement("option");
    o.value = a; o.textContent = a;
    sel.appendChild(o);
  });
  if (EDGE_ACCT !== "" && accounts().indexOf(EDGE_ACCT) < 0) { EDGE_ACCT = ""; LS.set("pel_edge_acct", EDGE_ACCT); }
  sel.value = EDGE_ACCT;
  // the cut list is drawn from the trades in THIS scope, so it has to be rebuilt
  // whenever the scope can have changed
  refreshEdgeCutSel();
}
function renderAcctSel() {
  const sel = $s("jAcct");
  sel.innerHTML = "";
  const all = document.createElement("option");
  all.value = ""; all.textContent = "All accounts (combined)";
  sel.appendChild(all);
  accounts().forEach((a) => {
    const o = document.createElement("option");
    o.value = a; o.textContent = a;
    sel.appendChild(o);
  });
  sel.value = ACCT;
  $("jDelAcct").classList.toggle("hide", ACCT === "");
  refreshEdgeAcctSel();
  const bals = JMETA.balances || {};
  const lbl = $("jStartBalLbl");
  const inp = $i("jStartBal");
  const rInp = $i("jRVal");
  const rLbl = $("jRValLbl");
  const basis = ACCT === "" ? null : (JMETA.rBasis || {})[ACCT];
  const pct = !!basis && basis.mode === "pct";
  $("jRModeFixed").setAttribute("aria-pressed", String(!pct));
  $("jRModePct").setAttribute("aria-pressed", String(pct));
  if (ACCT === "") {
    lbl.textContent = "Starting balance (per account)";
    inp.disabled = true;
    inp.value = "";
    inp.placeholder = "pick an account to set";
    rLbl.textContent = "What 1R is worth (per account)";
    rInp.disabled = true;
    rInp.value = "";
    rInp.placeholder = "pick an account to set";
  } else {
    lbl.textContent = "Starting balance ($) - " + ACCT;
    inp.disabled = false;
    inp.placeholder = "e.g. 100000";
    const b = bals[ACCT];
    inp.value = b == null ? "" : String(b);
    rLbl.textContent = "What 1R is worth - " + ACCT;
    rInp.disabled = false;
    rInp.placeholder = pct ? "e.g. 1 (= 1% of start)" : "e.g. 50";
    rInp.value = basis ? String(basis.v) : "";
  }
  $("jRModeSeg").querySelectorAll("button").forEach((b) => { (b as HTMLButtonElement).disabled = ACCT === ""; });
}
// write (or clear) the current account's dollar basis from the two inputs
function setRBasis() {
  if (ACCT === "") return;
  const raw = $i("jRVal").value;
  const n = raw === "" ? null : Number(raw);
  JMETA.rBasis = JMETA.rBasis || {};
  if (n == null || !isFinite(n) || n <= 0) delete JMETA.rBasis[ACCT];
  else JMETA.rBasis[ACCT] = { mode: $("jRModePct").getAttribute("aria-pressed") === "true" ? "pct" : "fixed", v: n };
  // no oddsCache bust on purpose: the R value buys dollars, not edge. The odds
  // panel, Kelly, SQN and the suggester all read R and must not move for it.
  saveMeta();
  renderJournal();
}
function setScope(a: string) {
  ACCT = a;
  LS.set("pel_acct", ACCT);
  SEL.clear();
  clearSeg();
  // the calendar month re-derives from the NEW scope's newest trade - it was
  // pinned to the old account's month, so an account whose trades are all in
  // March rendered as an untraded July until the user paged backwards by hand
  calMonth = null;
  if (SELMODE) { SELMODE = false; updateSelUI(); }
  renderAcctSel();
  renderJournal();
  if ($i("useJournal").checked) applyJournalEdge();
}
function deleteAccountFlow() {
  if (ACCT === "") return;
  const name = ACCT;
  const doomed = JT.filter((t) => accOf(t) === name);
  ask("Delete account <b>" + esc(name) + "</b> and its <b>" + doomed.length + "</b> logged trade" + (doomed.length === 1 ? "" : "s") + "?<br><br>You can Undo for a few seconds afterwards. After that, trades and screenshots are gone unless you have a backup.", [
    { label: "Cancel", kind: "", value: false },
    { label: "Delete account", kind: "danger", value: true },
  ], (yes) => {
    if (!yes) return;
    // Undo, like every other delete: the account's trades and settings are
    // held until the toast closes, and its screenshots are erased only then
    const beforeMeta = JSON.parse(JSON.stringify(JMETA)) as JMeta;
    const beforeEdge = EDGE_ACCT;
    JT = JT.filter((t) => accOf(t) !== name);
    JMETA.accounts = accounts().filter((a) => a !== name);
    if (!JMETA.accounts.length) JMETA.accounts = ["Main"];
    if (JMETA.balances) delete JMETA.balances[name];
    if (JMETA.accountFirms) delete JMETA.accountFirms[name];
    if (JMETA.accountPhase) delete JMETA.accountPhase[name];
    if (JMETA.rBasis) delete JMETA.rBasis[name];
    if (name === "Main") JMETA.startBalance = null;
    if (EDGE_ACCT === name) { EDGE_ACCT = ""; LS.set("pel_edge_acct", EDGE_ACCT); }
    Store.persistAll(JT, JMETA, () => {
      if (!TAURI) LS.set("pel_jmeta", JMETA);
      setScope("");
      toastAction('Account "' + name + '" deleted (' + doomed.length + " trades removed).", "Undo", () => {
        const have = new Set(JT.map((t) => t.id));
        JT = JT.concat(doomed.filter((t) => !have.has(t.id)));
        JT.sort((a, b) => (b.dateTime || "").localeCompare(a.dateTime || ""));
        for (const k of Object.keys(JMETA)) delete (JMETA as unknown as Record<string, unknown>)[k];
        Object.assign(JMETA, beforeMeta);
        if (beforeEdge === name) { EDGE_ACCT = name; LS.set("pel_edge_acct", EDGE_ACCT); }
        Store.persistAll(JT, JMETA, () => {
          if (!TAURI) LS.set("pel_jmeta", JMETA);
          setScope(name);
          toast('Account "' + name + '" restored (' + doomed.length + " trades).");
        });
      }, () => {
        doomed.forEach((t) => (t.imageIds || []).forEach((iid) => { Store.deleteImage(iid); delete urlCache[iid]; }));
      });
    });
  });
}
function newAccountFlow() {
  ask('Name the new account:<br><br><input id="acctName" class="numin" style="width:100%;text-align:left" placeholder="Challenge, Personal, FTMO 100k...">', [
    { label: "Cancel", kind: "", value: false },
    { label: "Create", kind: "primary", value: true },
  ], (yes) => {
    if (!yes) return;
    const inp = document.getElementById("acctName") as HTMLInputElement | null;
    const name = inp ? inp.value.trim() : "";
    if (!name) { toast("Give the account a name."); return; }
    if (accounts().indexOf(name) >= 0) { toast("That account already exists."); setScope(name); return; }
    JMETA.accounts = accounts().concat([name]);
    JMETA.balances = JMETA.balances || {};
    JMETA.balances[name] = null;
    saveMeta();
    setScope(name);
    toast('Account "' + name + '" created - new trades land here while it is selected.');
  });
  const inp = document.getElementById("acctName") as HTMLInputElement | null;
  if (inp) inp.focus();
}

// ---------- detail ----------
function openDetail(id: string) {
  const t = JT.find((x) => x.id === id);
  if (!t) return;
  DETAIL_ID = id;
  const r = tradeR(t);
  $("dtTitle").textContent = (t.instrument || "Trade") + (t.setup ? " - " + t.setup : "");
  const rEl = $("dtR");
  rEl.textContent = (r >= 0 ? "+" : "") + r.toFixed(2) + "R";
  rEl.className = "mono " + (r > 0.0001 ? "cell-go" : r < -0.0001 ? "cell-stop" : "muted");
  let tags = "";
  if (t.tags) {
    if (t.tags.quality) tags += '<span class="tag q">' + esc(t.tags.quality) + "</span> ";
    (t.tags.mistake || []).forEach((m) => { tags += '<span class="tag m">' + esc(m) + "</span> "; });
    (t.tags.condition || []).forEach((c) => { tags += '<span class="tag">' + esc(c) + "</span> "; });
  }
  $("dtTags").innerHTML = tags || '<span class="muted small">no tags</span>';
  const dm = durationMin(t);
  const ex = excursions(t);
  // whichever way the excursion was logged, the detail view says which one it was
  const signR = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(2) + "R";
  const mfeCell = hasNum(t.mfeR) ? signR(ex.mfeR!) + "  (logged in R)"
    : hasNum(t.mfeD) ? money(Number(t.mfeD)) + (ex.mfeR != null ? "  (" + signR(ex.mfeR) + ")" : "  (no R value to convert)")
      : t.mfe == null ? "--" : String(t.mfe) + (ex.mfeR != null ? "  (" + signR(ex.mfeR) + ")" : "");
  const maeCell = hasNum(t.maeR) ? "-" + Math.abs(ex.maeR!).toFixed(2) + "R heat  (logged in R)"
    : hasNum(t.maeD) ? money(Math.abs(Number(t.maeD))) + (ex.maeR != null ? "  (-" + Math.abs(ex.maeR).toFixed(2) + "R heat)" : "  (no R value to convert)")
      : t.mae == null ? "--" : String(t.mae) + (ex.maeR != null ? "  (-" + Math.abs(ex.maeR).toFixed(2) + "R heat)" : "");
  const rows: [string, string][] = [
    ["Account", accOf(t)],
    ["When", (t.dateTime || "--").replace("T", "  ") + (t.exitTime ? "  ->  " + t.exitTime.replace("T", "  ") : "")],
    ["Held", dm != null ? fmtDur(dm) : "--"],
    ["Direction", t.direction || "--"],
    ["Setup", t.setup || "--"],
    ["Entry model", modelOf(t) || "--"],
    ["Session", t.session || "--"],
    ["Entry / stop / exit", [t.entry, t.stop, t.exit].map((x) => (x == null ? "--" : String(x))).join("  /  ")],
    ["Target", t.target == null ? "--" : String(t.target)],
    ["MFE / MAE", mfeCell + "  /  " + maeCell],
    ["Size", t.size == null ? "--" : String(t.size)],
    ["Risk (1R)", t.riskAmt == null ? (rValue(accOf(t)) == null ? "--" : money(rValue(accOf(t))!) + "  (account R value)") : money(t.riskAmt)],
    // a derived figure says so - the detail view is where someone checks a number
    ["P&L", (() => { const d = trade$(t); return d == null ? "--" : money(d) + (hasNum(t.pnl) ? "" : "  (from R)"); })()],
    ["Fees", t.fees == null ? "--" : money(t.fees)],
    ["Followed plan", t.followedPlan ? "Yes" : "No"],
    ["Emotion", (t.emotionBefore || "-") + " -> " + (t.emotionAfter || "-") + "  (1 calm, 5 tilted)"],
  ];
  $("dtDl").innerHTML = rows.map((rw) => "<dt>" + esc(rw[0]) + "</dt><dd>" + esc(rw[1]) + "</dd>").join("");
  // prev/next navigate the current filtered list (the list the user is looking at)
  const nav = filtered();
  const idx = nav.findIndex((x) => x.id === id);
  ($("dtPrev") as HTMLButtonElement).disabled = idx <= 0;
  ($("dtNext") as HTMLButtonElement).disabled = idx < 0 || idx >= nav.length - 1;
  $("dtPlanWrap").classList.toggle("hide", !t.planText);
  $("dtPlan").textContent = t.planText || "";
  $("dtNotesWrap").classList.toggle("hide", !t.notes);
  $("dtNotes").textContent = t.notes || "";
  const gal = $("dtGallery");
  gal.innerHTML = "";
  const ids = t.imageIds || [];
  // append the slots up front so images keep their logged order regardless of
  // which store read finishes first
  ids.forEach((iid, i) => {
    const im = document.createElement("img");
    im.alt = "trade screenshot " + (i + 1) + " of " + ids.length;
    if (i === 0 && ids.length) im.className = "lead";
    im.addEventListener("click", () => openLightbox(ids, i));
    gal.appendChild(im);
    Store.getImage(iid, (rec) => {
      if (rec && rec.blob) im.src = imgURL(iid, rec.blob);
      else im.remove();
    });
  });
  $("detailOv").classList.remove("hide");
  ($("detailOv").querySelector(".sheet-body") as HTMLElement).scrollTop = 0;
}
// ---------- lightbox: full-resolution viewer with zoom / pan / paging ----------
let LB_IDS: string[] = [];
let LB_IDX = 0;
let lbScale = 1, lbX = 0, lbY = 0, lbDragging = false, lbSX = 0, lbSY = 0, lbMoved = false;
function lbApply() {
  const im = $("lightboxImg") as HTMLImageElement;
  im.style.transform = "translate(" + lbX + "px," + lbY + "px) scale(" + lbScale + ")";
  im.style.cursor = lbScale > 1 ? (lbDragging ? "grabbing" : "grab") : "zoom-in";
  $("lbZoom").textContent = Math.round(lbScale * 100) + "%";
}
function lbFit() { lbScale = 1; lbX = 0; lbY = 0; lbApply(); }
// zoom about a screen point so the pixel under the cursor stays put
function lbZoomAt(factor: number, cx?: number, cy?: number) {
  const prev = lbScale;
  lbScale = Math.max(1, Math.min(8, lbScale * factor));
  if (lbScale === prev) return;
  if (cx != null && cy != null) {
    const r = ($("lightboxImg") as HTMLImageElement).getBoundingClientRect();
    const ox = cx - (r.left + r.width / 2), oy = cy - (r.top + r.height / 2);
    const k = lbScale / prev;
    lbX = lbX - ox * (k - 1);
    lbY = lbY - oy * (k - 1);
  }
  if (lbScale === 1) { lbX = 0; lbY = 0; }
  lbApply();
}
function lbShow() {
  const id = LB_IDS[LB_IDX];
  const im = $("lightboxImg") as HTMLImageElement;
  Store.getImage(id, (rec) => { if (rec && rec.blob) im.src = imgURL(id, rec.blob); });
  const many = LB_IDS.length > 1;
  $("lbPrev").classList.toggle("hide", !many);
  $("lbNext").classList.toggle("hide", !many);
  $("lbCount").classList.toggle("hide", !many);
  $("lbCount").textContent = LB_IDX + 1 + " / " + LB_IDS.length;
  ($("lbPrev") as HTMLButtonElement).disabled = LB_IDX <= 0;
  ($("lbNext") as HTMLButtonElement).disabled = LB_IDX >= LB_IDS.length - 1;
  lbFit();
}
function openLightbox(ids: string[], idx: number) {
  LB_IDS = ids.slice();
  LB_IDX = Math.max(0, Math.min(idx, LB_IDS.length - 1));
  lbShow();
  $("lightbox").classList.remove("hide");
}
function lbNav(d: number) {
  const n = LB_IDX + d;
  if (n < 0 || n >= LB_IDS.length) return;
  LB_IDX = n;
  lbShow();
}
function lbClose() { $("lightbox").classList.add("hide"); }
function wireLightbox() {
  const box = $("lightbox"), im = $("lightboxImg") as HTMLImageElement;
  $("lbClose").addEventListener("click", lbClose);
  $("lbPrev").addEventListener("click", () => lbNav(-1));
  $("lbNext").addEventListener("click", () => lbNav(1));
  $("lbIn").addEventListener("click", () => lbZoomAt(1.35));
  $("lbOut").addEventListener("click", () => lbZoomAt(1 / 1.35));
  $("lbFit").addEventListener("click", lbFit);
  // Zoom proportional to the scroll magnitude. A mouse wheel sends one big notch
  // (deltaY ~100); a Mac trackpad sends a burst of tiny deltas, and a fixed step
  // per event would slam straight to max zoom. deltaMode normalizes Firefox's
  // line/page units. Pinch-to-zoom arrives as ctrl+wheel and gets a bigger bite.
  box.addEventListener("wheel", (e) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    const dy = e.deltaY * unit * (e.ctrlKey ? 3 : 1);
    const step = Math.max(0.5, Math.min(2, Math.exp(-dy * 0.0022)));
    lbZoomAt(step, e.clientX, e.clientY);
  }, { passive: false });
  im.addEventListener("mousedown", (e) => {
    if (lbScale <= 1) return;
    e.preventDefault();
    lbDragging = true; lbMoved = false;
    lbSX = e.clientX - lbX; lbSY = e.clientY - lbY;
    lbApply();
  });
  window.addEventListener("mousemove", (e) => {
    if (!lbDragging) return;
    lbX = e.clientX - lbSX; lbY = e.clientY - lbSY;
    lbMoved = true;
    lbApply();
  });
  window.addEventListener("mouseup", () => { if (lbDragging) { lbDragging = false; lbApply(); } });
  im.addEventListener("dblclick", (e) => { e.stopPropagation(); if (lbScale > 1) lbFit(); else lbZoomAt(2.5, e.clientX, e.clientY); });
  // click the backdrop to close; a click that ended a pan must not close
  box.addEventListener("click", (e) => {
    if (lbMoved) { lbMoved = false; return; }
    if (e.target === im) { if (lbScale <= 1) lbZoomAt(2.5, e.clientX, e.clientY); return; }
    if ((e.target as HTMLElement).closest(".lb-bar")) return;
    lbClose();
  });
}

function detailNav(delta: number) {
  if (!DETAIL_ID) return;
  const nav = filtered();
  const idx = nav.findIndex((x) => x.id === DETAIL_ID);
  const nx = idx + delta;
  if (idx < 0 || nx < 0 || nx >= nav.length) return;
  openDetail(nav[nx].id);
}

// ---------- export / import ----------
function blobToDataURL(b: Blob, cb: (u: string | null) => void) {
  const fr = new FileReader();
  fr.onload = () => cb(String(fr.result));
  fr.onerror = () => cb(null);
  fr.readAsDataURL(b);
}
function dataURLtoBlob(u: string): Blob | null {
  try {
    const parts = u.split(",");
    const mime = (parts[0].match(/:(.*?);/) || [])[1] || "image/jpeg";
    const bin = atob(parts[1]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  } catch { return null; }
}
function stripForExport(t: Trade): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  const src = t as unknown as Record<string, unknown>;
  for (const k in src) if (k.charAt(0) !== "_") c[k] = src[k];
  return c;
}
function buildExportJson(cb: (json: string) => void) {
  const ids: string[] = [];
  JT.forEach((t) => (t.imageIds || []).forEach((i) => { if (ids.indexOf(i) < 0) ids.push(i); }));
  const images: { id: string; w?: number; h?: number; dataUrl: string }[] = [];
  let pend = ids.length;
  const finish = () => {
    const out = {
      app: "prop-edge-lab", version: 3, exportedAt: new Date().toISOString(),
      meta: { startBalance: JMETA.startBalance, accounts: accounts(), balances: JMETA.balances || {}, accountFirms: JMETA.accountFirms || {}, accountPhase: JMETA.accountPhase || {}, rBasis: JMETA.rBasis || {} },
      trades: JT.map(stripForExport), images,
    };
    cb(JSON.stringify(out));
  };
  if (!pend) { finish(); return; }
  ids.forEach((id) =>
    Store.getImage(id, (rec) => {
      if (rec && rec.blob) {
        blobToDataURL(rec.blob, (u) => { if (u) images.push({ id, w: rec.w, h: rec.h, dataUrl: u }); if (--pend <= 0) finish(); });
      } else if (--pend <= 0) finish();
    }));
}
function doExport() {
  // A journal with no trades can still carry real setup - starting balances,
  // R values, bound firms, phases - and in the browser build that lives only
  // in this browser's localStorage, which is exactly what the storage note
  // tells the user to back up. Refusing to export it made the advice
  // impossible to follow. Only refuse when there is genuinely nothing.
  const hasMeta = !!(Object.keys(JMETA.balances || {}).length || Object.keys(JMETA.rBasis || {}).length ||
    Object.keys(JMETA.accountFirms || {}).length || (JMETA.accounts || []).length > 1);
  if (!JT.length && !hasMeta) { toast("Nothing to export yet."); return; }
  if (!JT.length) toast("No trades yet — exporting your accounts and settings.");
  buildExportJson((json) => {
    const name = "prop-edge-lab-journal-" + localDate() + ".json";
    if (Store.exportJson) {
      Store.exportJson(json, (p, err) => {
        if (p) { toast("Backup written: " + p); JMETA.lastAutoBackup = Date.now(); saveMeta(); }
        else toast("Export failed: " + err);
      });
      return;
    }
    try {
      const b = new Blob([json], { type: "application/json" });
      const u = URL.createObjectURL(b);
      const a = document.createElement("a");
      a.href = u; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 1500);
      toast("Backup downloaded.");
      JMETA.lastAutoBackup = Date.now();
      saveMeta();
    } catch { toast("Could not export in this environment."); }
  });
}
// weekly safety net: in the app, silently write a backup into exports/;
// in the browser (no filesystem), offer the download instead
const BACKUP_EVERY = 7 * 24 * 3600 * 1000;
export function maybeAutoBackup() {
  if (!JT.length) return;
  const last = JMETA.lastAutoBackup || 0;
  // browser build, first sight of data: start the clock silently instead of
  // nagging a brand-new user (the Tauri build just writes the backup - free)
  if (!TAURI && !last) {
    JMETA.lastAutoBackup = Date.now();
    saveMeta();
    return;
  }
  if (Date.now() - last < BACKUP_EVERY) return;
  const inv = TAURI;
  if (inv && Store.exportJson) {
    buildExportJson((json) => {
      inv("export_journal", { data: json, silent: true, kind: "auto" }).then((p) => {
        JMETA.lastAutoBackup = Date.now();
        saveMeta();
        toast("Weekly auto-backup written: " + String(p));
      }).catch(() => { /* retried next launch */ });
    });
  } else {
    ask("It has been over a week since your last journal backup. In the browser this journal only lives in this browser &mdash; download a backup now?", [
      { label: "Later", kind: "", value: false },
      { label: "Download backup", kind: "primary", value: true },
    ], (yes) => {
      // either way, don't nag again for a week
      JMETA.lastAutoBackup = Date.now();
      saveMeta();
      if (yes) doExport();
    });
  }
}
// ---------- import hardening ----------
// A backup file is untrusted: a crafted one can carry a field that is not the
// type the rest of the app assumes (an array/object where a string is expected),
// which sidesteps guards like slice() and can reach an innerHTML sink, and keys
// like "__proto__" that poison Object.prototype through the for-in copies below.
// Everything imported is coerced to a known-good shape here, at the boundary.
function isDangerousKey(k: string): boolean { return k === "__proto__" || k === "constructor" || k === "prototype"; }
function safeStr(v: unknown, max = 2000): string {
  if (v == null) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v !== "string") return "";     // arrays/objects are NOT strings - drop, do not stringify
  return v.length > max ? v.slice(0, max) : v;
}
function safeNum(v: unknown): number | null {
  return v != null && v !== "" && (typeof v === "number" || typeof v === "string") && isFinite(Number(v)) ? Number(v) : null;
}
function safeStrArr(v: unknown, cap = 40): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, cap) as string[] : [];
}
// ids become part of a filesystem path (images/<id>.jpg) and the safe_id Rust
// guard only allows [A-Za-z0-9_-]{1,64}; mirror that here so a bad id is dropped
// before it can break dedup keys or reach the image commands.
function safeId(v: unknown): string | null {
  const s = typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null;
}
function sanitizeTrade(raw: unknown): Trade | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = safeId(r.id);
  if (!id) return null;   // no usable id -> not importable
  const rt = r.tags && typeof r.tags === "object" ? r.tags as Record<string, unknown> : {};
  const dir = r.direction === "short" ? "short" : "long";
  return {
    id,
    // an account name becomes an object key (balances, rBasis, phases)
    account: ((a) => (a && !isDangerousKey(a) ? a : "Main"))(safeStr(r.account, 80)),
    dateTime: safeStr(r.dateTime, 40),
    instrument: safeStr(r.instrument, 40),
    direction: dir,
    session: safeStr(r.session, 40),
    setup: safeStr(r.setup, 120),
    entryModel: safeStr(r.entryModel, 120),
    entry: safeNum(r.entry), stop: safeNum(r.stop), target: safeNum(r.target), exit: safeNum(r.exit),
    size: safeNum(r.size), riskAmt: safeNum(r.riskAmt), pnl: safeNum(r.pnl), fees: safeNum(r.fees),
    // Rmanual absent (pre-2.1 backups) with a stored R means the R IS the
    // record - computeR's own legacy branch honours exactly that. Forcing it to
    // false re-derived R on import and turned every P&L-only legacy row into a
    // fabricated +/-1 while dropping it from the R statistics.
    R: safeNum(r.R), Rmanual: r.Rmanual === true || (r.Rmanual == null && safeNum(r.R) != null),
    pnlManual: r.pnlManual === true,
    followedPlan: r.followedPlan !== false,
    planText: safeStr(r.planText, 20000), notes: safeStr(r.notes, 20000),
    tags: { quality: safeStr(rt.quality, 60), mistake: safeStrArr(rt.mistake), condition: safeStrArr(rt.condition) },
    emotionBefore: safeNum(r.emotionBefore) || 0, emotionAfter: safeNum(r.emotionAfter) || 0,
    exitTime: safeStr(r.exitTime, 40) || null, mfe: safeNum(r.mfe), mae: safeNum(r.mae),
    mfeR: safeNum(r.mfeR), maeR: safeNum(r.maeR), mfeD: safeNum(r.mfeD), maeD: safeNum(r.maeD),
    runR: safeNum(r.runR), rrR: safeNum(r.rrR),
    imageIds: (Array.isArray(r.imageIds) ? r.imageIds : []).map(safeId).filter((x): x is string => !!x).slice(0, 12),
    createdAt: safeNum(r.createdAt) || undefined,
  };
}
// copy own string-keyed entries while skipping prototype-polluting keys
// keepExisting: a MERGE fills in accounts the journal does not have yet, and
// never rewrites the settings of one it does (a months-old backup merged in
// used to reset today's starting balance, R value and phase to the old ones)
function safeAssign<T>(dst: Record<string, T>, src: unknown, coerce: (v: unknown) => T | null, keepExisting = false) {
  if (!src || typeof src !== "object") return;
  for (const k of Object.keys(src as object)) {
    if (isDangerousKey(k)) continue;
    if (keepExisting && Object.prototype.hasOwnProperty.call(dst, k)) continue;
    const v = coerce((src as Record<string, unknown>)[k]);
    if (v != null) dst[k] = v;
  }
}

type ImportData = { meta?: { startBalance?: number | null }; trades?: Trade[]; images?: { id: string; w?: number; h?: number; dataUrl?: string }[] };
function doImport(file: File) {
  if (!JLOADED) { toast("Journal is still loading - try again in a second."); return; }
  if (file.size > 64 * 1024 * 1024) { toast("That file is over 64 MB - too large to import safely."); return; }
  const fr = new FileReader();
  fr.onload = () => {
    // a byte-order mark (Notepad, Excel) is not part of the content
    const text = String(fr.result).replace(/^\uFEFF/, "");
    // a CSV is recognised by name or by not being JSON at all
    if (/\.(csv|txt|tsv)$/i.test(file.name) || !/^\s*[\[{]/.test(text)) { importCsv(text); return; }
    let data: ImportData;
    try { data = JSON.parse(text); } catch { toast("That file is not a valid journal backup."); return; }
    importData(data);
  };
  fr.readAsText(file);
}
// the sample journal goes through exactly the path a backup does
export function loadSample() {
  if (!JLOADED) { toast("Journal is still loading - try again in a second."); return; }
  importData(generateSample(Date.now()) as unknown as ImportData, true);
}
function importData(data: ImportData, sample = false, extra = "") {
    if (!data || !Array.isArray(data.trades)) { toast("No trades found in that file."); return; }
    // Sanitize the whole payload up front, BEFORE anything is deleted or written,
    // so replace-mode never destroys the existing journal for a bad file (#7) and
    // no untrusted value is trusted downstream (#1/#8/#9).
    let imported: Trade[];
    const imgs = Array.isArray(data.images) ? data.images.slice(0, 5000) : [];
    try {
      imported = (data.trades as unknown[]).map(sanitizeTrade).filter((t): t is Trade => !!t);
    } catch { toast("That backup could not be read."); return; }
    if (!imported.length) { toast("No importable trades in that file (missing or invalid ids)."); return; }
    // only keep image ids the sanitized trades actually reference
    const referenced: Record<string, 1> = {};
    imported.forEach((t) => t.imageIds.forEach((iid) => { referenced[iid] = 1; }));

    // Replace erases the journal, so it is never the only copy: the current
    // journal is written out FIRST (desktop: exports/before-replace-*.json;
    // browser: a download), and only a successful copy lets Replace go ahead.
    // Undo then restores it in place; screenshots of the replaced trades are
    // kept until the Undo window closes.
    let before: { trades: Trade[]; meta: JMeta } | null = null;
    let savedTo = "";
    const snapshotThen = (next: () => void) => {
      before = { trades: JT.slice(), meta: JSON.parse(JSON.stringify(JMETA)) as JMeta };
      buildExportJson((json) => {
        if (TAURI) {
          TAURI("export_journal", { data: json, silent: true, kind: "before-replace" })
            .then((p) => { savedTo = String(p); next(); })
            .catch((e: unknown) => { before = null; toast("Replace cancelled: a copy of your current journal could not be saved first (" + String(e) + "). Nothing was changed."); });
          return;
        }
        try {
          const u = URL.createObjectURL(new Blob([json], { type: "application/json" }));
          const a = document.createElement("a");
          a.href = u; a.download = "edge-lab-before-replace-" + localDate() + ".json";
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(u), 1500);
          savedTo = "your downloads";
          next();
        } catch { before = null; toast("Replace cancelled: a copy of your current journal could not be saved first. Nothing was changed."); }
      });
    };
    const undoReplace = (snap: { trades: Trade[]; meta: JMeta }, newTrades: Trade[]) => {
      const keepImg = new Set<string>();
      snap.trades.forEach((t) => (t.imageIds || []).forEach((i) => keepImg.add(i)));
      newTrades.forEach((t) => (t.imageIds || []).forEach((i) => { if (!keepImg.has(i)) { Store.deleteImage(i); delete urlCache[i]; } }));
      JT = snap.trades;
      for (const k of Object.keys(JMETA)) delete (JMETA as unknown as Record<string, unknown>)[k];
      Object.assign(JMETA, snap.meta);
      if (!TAURI) LS.set("pel_jmeta", JMETA);
      normalizeMeta();
      renderAcctSel();
      Store.persistAll(JT, JMETA, () => {
        renderJournal();
        if ($i("useJournal").checked) applyJournalEdge();
        toast("Restored your journal (" + JT.length + " trades).");
      });
    };
    // after the Undo window: screenshots only the replaced trades used can go
    const dropOldImages = (snap: { trades: Trade[] }) => {
      const live = new Set<string>();
      JT.forEach((t) => (t.imageIds || []).forEach((i) => live.add(i)));
      snap.trades.forEach((t) => (t.imageIds || []).forEach((i) => { if (!live.has(i)) { Store.deleteImage(i); delete urlCache[i]; } }));
    };

    const run = (mode: unknown) => {
      if (mode === "cancel") return;
      const writeAll = () => {
        let trades = imported;
        if (mode === "merge") {
          const have: Record<string, 1> = {};
          JT.forEach((t) => { have[t.id] = 1; });
          trades = trades.filter((t) => !have[t.id]);
        }
        const validImgs = imgs.filter((im) => im && typeof im === "object" && safeId((im as { id?: unknown }).id) && referenced[String((im as { id: string }).id)]);
        let pend = validImgs.length;
        const writeTrades = () => {
          trades.forEach((t) => { t._R = computeR(t); });
          JT = mode === "merge" ? JT.concat(trades) : trades;
          JT.sort((a, b) => (b.dateTime || "").localeCompare(a.dateTime || ""));
          const im = data.meta as Record<string, unknown> | undefined;
          if (im && typeof im === "object") {
            const sb = safeNum(im.startBalance);
            if (sb != null && (mode === "replace" || JMETA.startBalance == null)) JMETA.startBalance = sb;
            if (Array.isArray(im.accounts)) {
              const incoming = safeStrArr(im.accounts, 200);
              const merged = mode === "replace" ? incoming.slice() : accounts().slice();
              (mode === "replace" ? accounts() : incoming).forEach((a) => { if (merged.indexOf(a) < 0) merged.push(a); });
              JMETA.accounts = merged.length ? merged : ["Main"];
            }
            JMETA.balances = JMETA.balances || {};
            const keep = mode === "merge";
            safeAssign(JMETA.balances, im.balances, (v) => { const n = safeNum(v); return n == null ? null : n; }, keep);
            JMETA.accountFirms = JMETA.accountFirms || {};
            safeAssign(JMETA.accountFirms, im.accountFirms, (v) => (v && typeof v === "object" ? v as Firm : null), keep);
            JMETA.accountPhase = JMETA.accountPhase || {};
            safeAssign(JMETA.accountPhase, (im as { accountPhase?: unknown }).accountPhase, (v) => {
              const o = v as { phase?: string; since?: string };
              return o && (o.phase === "eval" || o.phase === "funded")
                ? { phase: o.phase, ...(typeof o.since === "string" ? { since: o.since } : {}) }
                : null;
            }, keep);
            JMETA.rBasis = JMETA.rBasis || {};
            safeAssign(JMETA.rBasis, (im as { rBasis?: unknown }).rBasis, sanitizeRBasis, keep);
            if (!TAURI) LS.set("pel_jmeta", JMETA);
          }
          normalizeMeta();
          renderAcctSel();
          Store.persistAll(JT, JMETA, () => {
            // the sample is for looking around: show it, rather than an empty
            // scoped account and a hint to go and find it
            if (sample && ACCT !== "" && ACCT !== SAMPLE_ACCT) setScope(SAMPLE_ACCT);
            renderJournal();
            if ($i("useJournal").checked) applyJournalEdge();
            // name where the rows LANDED. With scope on account A, a backup
            // whose trades are on account B imported successfully while the
            // screen said "No trades in A" - a restore indistinguishable from
            // a failed one unless the toast says which account got them.
            const dests: string[] = [];
            trades.forEach((t) => { const a = accOf(t); if (dests.indexOf(a) < 0) dests.push(a); });
            const elsewhere = ACCT !== "" && dests.every((a) => a !== ACCT);
            const msg = "Imported " + trades.length + " trades into " + dests.join(", ") +
              (elsewhere ? " — you are viewing " + ACCT + "; switch account scope to see them." : ".") +
              (extra ? " " + extra + "." : "");
            const snap = before;
            if (snap) {
              toastAction("Replaced your " + snap.trades.length + " trades. " + msg + " The old journal was saved to " + savedTo + ".", "Undo",
                () => undoReplace(snap, trades), () => dropOldImages(snap), 20000);
            } else toast(msg);
          });
        };
        if (!pend) { writeTrades(); return; }
        validImgs.forEach((im) => {
          const b = im.dataUrl ? dataURLtoBlob(im.dataUrl) : null;
          if (b && b.size <= 24 * 1024 * 1024) Store.putImage({ id: String(im.id), blob: b, w: im.w, h: im.h }, () => { if (--pend <= 0) writeTrades(); });
          else if (--pend <= 0) writeTrades();
        });
      };
      if (mode === "replace" && JT.length) snapshotThen(writeAll);
      else writeAll();
    };
    if (JT.length) {
      ask("Import <b>" + imported.length + "</b> trades" + (sample ? " of sample data" : "") + ".<br><br>" +
        "<b>Merge</b> adds them to your " + JT.length + " trades. <b>Replace</b> removes your " + JT.length + " trades and keeps only these " +
        "(a copy of your current journal is saved first" + (TAURI ? ", in exports" : " as a download") + ").", [
        { label: "Cancel", kind: "", value: "cancel" },
        { label: "Replace", kind: "danger", value: "replace" },
        { label: "Merge", kind: "primary", value: "merge" },
      ], run);
    } else run("replace");
}

// ---------- CSV import ----------
// A plain spreadsheet export: one row per trade, a header row naming the
// columns. Only a date and a result are required - R, or P&L with a Risk $
// column. Every row is turned into an ordinary backup record and handed to
// importData, so it passes the same sanitizer and the same merge/replace
// question as a JSON backup. Ids are a hash of the row, so importing the same
// file twice with Merge adds nothing the second time.
const CSV_COLS: Record<string, string[]> = {
  // names that carry a DATE come before names that may carry only a clock
  date: ["date", "datetime", "date/time", "date time", "trade date", "open date", "entry date", "opened", "open time", "entry time", "time"],
  exitTime: ["exit time", "close time", "closed", "exit date", "close date"],
  R: ["r", "r multiple", "r-multiple", "rmultiple", "result r", "r result", "net r"],
  pnl: ["pnl", "p&l", "p/l", "profit", "net pnl", "net p&l", "net profit", "profit/loss", "result $", "gain"],
  riskAmt: ["risk", "risk $", "risk$", "riskamt", "risk amount", "1r", "$ risk"],
  setup: ["setup", "tag", "strategy", "playbook"],
  direction: ["direction", "side", "type", "long/short", "buy/sell"],
  instrument: ["instrument", "symbol", "ticker", "market", "asset", "contract"],
  account: ["account", "acct"],
  session: ["session"],
  notes: ["notes", "note", "comment", "comments"],
  fees: ["fees", "commission", "commissions", "fee"],
};
// a time-only column beside a date-only one ("Date" + "Time" is the most
// common spreadsheet layout there is)
const CSV_TIME_COLS = ["time", "open time", "entry time", "time opened"];
function csvHead(h: string): { name: string; unit: string } {
  const s = h.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/_+/g, " ").replace(/\s+/g, " ");
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(s);
  return m ? { name: m[1].trim(), unit: m[2].trim() } : { name: s, unit: "" };
}
export function parseCsvRows(text: string): string[][] {
  let body = text.replace(/^\uFEFF/, "");
  // Excel writes "sep=;" as a first line to name the delimiter
  let delim = "";
  const sep = /^sep=(.)\r?\n/i.exec(body);
  if (sep) { delim = sep[1]; body = body.slice(sep[0].length); }
  if (!delim) {
    const first = body.split(/\r?\n/).find((l) => l.trim()) || "";
    // the delimiter is whichever of these the header uses most
    delim = [",", ";", "\t", "|"].map((d) => [d, first.split(d).length] as [string, number]).sort((a, b) => b[1] - a[1])[0][0];
  }
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) {
      if (c === '"') { if (body[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && body[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}
// "1,234.50", "(120)", "$-80", "-1.5R", "1.234,50", "−2" -> numbers; anything else -> null
export function csvNum(v: string | undefined): number | null {
  if (v == null) return null;
  let s = v.trim().replace(/[\u2212\u2012\u2013]/g, "-").replace(/[$€£¥\s\u00a0']/g, "").replace(/r$/i, "");
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.includes(",") && s.includes(".")) {
    // whichever comes last is the decimal point
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (/^[-+]?\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, "");  // 1,234 grouping
  else s = s.replace(",", ".");                                            // 1,5 decimal comma
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return isFinite(n) ? (neg ? -n : n) : null;
}
// the date order a slashed date uses, read off the whole column: a first part
// over 12 can only be a day, a second part over 12 only a day. null = the file
// never says, and the user is asked rather than guessed for.
export function csvDateOrder(vals: string[]): "dmy" | "mdy" | null {
  let dmy = false, mdy = false;
  for (const v of vals) {
    const m = /^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(v);
    if (!m) continue;
    if (+m[1] > 12) dmy = true;
    if (+m[2] > 12) mdy = true;
  }
  return dmy && !mdy ? "dmy" : mdy && !dmy ? "mdy" : null;
}
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthOf = (w: string) => { const i = MONTHS.indexOf(w.slice(0, 3).toLowerCase()); return i < 0 ? 0 : i + 1; };
const p2 = (x: number) => String(x).padStart(2, "0");
// -> "YYYY-MM-DDTHH:MM", or "" when it is not a real date
export function csvDate(v: string | undefined, order: "dmy" | "mdy"): string {
  if (!v) return "";
  // a leading weekday ("Tue, 4 Mar 2025") says nothing the date does not
  const s = v.trim().replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i, "");
  let y: number, mo: number, d: number, rest: string, m: RegExpExecArray | null;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(.*)$/.exec(s))) { y = +m[1]; mo = +m[2]; d = +m[3]; rest = m[4]; }
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(.*)$/.exec(s))) {
    y = +m[3];
    [d, mo] = order === "dmy" ? [+m[1], +m[2]] : [+m[2], +m[1]];
    rest = m[4];
  } else if ((m = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})(.*)$/i.exec(s))) {   // Mar 4, 2025
    mo = monthOf(m[1]); d = +m[2]; y = +m[3]; rest = m[4];
  } else if ((m = /^(\d{1,2})[\s-]([a-z]{3,9})\.?[\s,-]+(\d{2,4})(.*)$/i.exec(s))) {             // 4 Mar 2025, 04-Mar-2025
    d = +m[1]; mo = monthOf(m[2]); y = +m[3]; rest = m[4];
  } else if ((m = /^(\d{5})(\.\d+)?$/.exec(s)) && +m[1] > 20000 && +m[1] < 80000) {
    // an Excel serial date (days since 1899-12-30), exported unformatted
    const t = new Date(Math.round((Number(s) - 25569) * 86400) * 1000);
    return t.getUTCFullYear() + "-" + p2(t.getUTCMonth() + 1) + "-" + p2(t.getUTCDate()) + "T" + p2(t.getUTCHours()) + ":" + p2(t.getUTCMinutes());
  } else return "";
  if (y < 100) y += 2000;
  // a real calendar day: 2025-02-31 is not "March 3rd", it is a typo
  if (mo < 1 || mo > 12 || d < 1 || new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) return "";
  let hh = 0, mm = 0;
  const t = /(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(am|pm)?/i.exec(rest || "");
  if (t) {
    hh = +t[1]; mm = +t[2];
    if (t[3]) { const pm = /pm/i.test(t[3]); if (hh === 12) hh = pm ? 12 : 0; else if (pm) hh += 12; }
    if (hh > 23 || mm > 59) return "";
  }
  return y + "-" + p2(mo) + "-" + p2(d) + "T" + p2(hh) + ":" + p2(mm);
}
const hasClock = (s: string) => /\d{1,2}:\d{2}/.test(s);
const onlyClock = (s: string) => /^\s*\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\s*(am|pm)?\s*$/i.test(s);
// two independent 32-bit FNV-1a hashes: a collision needs both to collide,
// so ids stay unique far past any real journal's size
function fnv(s: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
export function csvToTrades(text: string, order: "dmy" | "mdy" | null, fallbackAcct: string):
  { trades?: Record<string, unknown>[]; error?: string; needOrder?: boolean; noR?: number; skipped?: number } {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return { error: "That CSV has no trade rows under a header row." };
  const head = rows[0].map(csvHead);
  const col: Record<string, number> = {};
  for (const k of Object.keys(CSV_COLS)) {
    // aliases in priority order, not header order: with "Time" left of "Date",
    // Date must still win
    for (const a of CSV_COLS[k]) {
      // "P&L (R)" is an R column wearing a P&L name, and not a P&L column
      const i = head.findIndex((h) => h.name === a && !(k === "pnl" && h.unit === "r"));
      if (i >= 0) { col[k] = i; break; }
    }
    if (k === "R" && col.R == null) {
      const i = head.findIndex((h) => h.unit === "r" && CSV_COLS.pnl.includes(h.name));
      if (i >= 0) col.R = i;
    }
  }
  if (col.date == null) return { error: "No date column found. Name one column Date." };
  if (col.R == null && col.pnl == null) return { error: "No result column found. Name one column R (or P&L, with a Risk column)." };
  const timeCol = head.findIndex((h, i) => i !== col.date && CSV_TIME_COLS.includes(h.name));
  const exitDateCol = head.findIndex((h, i) => i !== col.exitTime && (h.name === "exit date" || h.name === "close date"));
  const body = rows.slice(1);
  const get = (r: string[], k: string) => (col[k] == null ? undefined : r[col[k]]);
  const dateCell = (r: string[]) => {
    const d = (r[col.date] || "").trim();
    return timeCol >= 0 && !hasClock(d) && r[timeCol] ? d + " " + r[timeCol].trim() : d;
  };
  const ord = order || csvDateOrder(body.map(dateCell));
  if (!ord && body.some((r) => /^\s*\d{1,2}[/.-]\d{1,2}[/.-]/.test(dateCell(r)))) return { needOrder: true };
  const seen: Record<string, number> = {}, used = new Set<string>();
  const trades: Record<string, unknown>[] = [];
  let skipped = 0, noR = 0;
  for (const r of body) {
    const dateTime = csvDate(dateCell(r), ord || "mdy");
    const R = csvNum(get(r, "R")), pnl = csvNum(get(r, "pnl")), risk = csvNum(get(r, "riskAmt"));
    if (!dateTime || (R == null && pnl == null)) { skipped++; continue; }
    if (R == null && !(risk != null && risk > 0)) noR++;
    const dirRaw = (get(r, "direction") || "").trim().toLowerCase();
    const direction = /^(s|short|sell)\b/.test(dirRaw) ? "short" : "long";
    let account = (get(r, "account") || "").trim() || fallbackAcct;
    if (isDangerousKey(account)) account = fallbackAcct;
    // an exit given as a bare clock time belongs to the entry's day (or the
    // next one, when it reads earlier than the entry)
    let exRaw = (get(r, "exitTime") || "").trim();
    if (onlyClock(exRaw) && exitDateCol >= 0 && (r[exitDateCol] || "").trim()) exRaw = r[exitDateCol].trim() + " " + exRaw;
    let exitTime = "";
    if (onlyClock(exRaw)) {
      exitTime = csvDate(dateTime.slice(0, 10) + " " + exRaw, "mdy");
      if (exitTime && exitTime < dateTime) {
        const n = new Date(Date.parse(dateTime.slice(0, 10) + "T00:00Z") + 86400000);
        exitTime = n.toISOString().slice(0, 10) + exitTime.slice(10);
      }
    } else exitTime = csvDate(exRaw, ord || "mdy");
    const instrument = (get(r, "instrument") || "").trim(), setup = (get(r, "setup") || "").trim();
    const notes = (get(r, "notes") || "").trim(), session = (get(r, "session") || "").trim();
    const key = [dateTime, exitTime, R, pnl, risk, instrument, setup, direction, session, account, notes].join("|");
    seen[key] = (seen[key] || 0) + 1;
    let id = "csv" + fnv(key, 0x811c9dc5) + fnv(key, 0x2f4a7c15) + (seen[key] > 1 ? "_" + seen[key] : "");
    while (used.has(id)) id += "x";
    used.add(id);
    trades.push({
      id, account, dateTime, exitTime: exitTime || null,
      instrument, direction, session, setup, entryModel: "",
      entry: null, stop: null, target: null, exit: null, size: null,
      riskAmt: risk != null && risk > 0 ? risk : null, pnl, fees: csvNum(get(r, "fees")),
      R, Rmanual: R != null, pnlManual: pnl != null,
      followedPlan: true, planText: "", notes,
      tags: { quality: "", mistake: [], condition: [] },
      emotionBefore: 0, emotionAfter: 0, imageIds: [],
    });
  }
  if (!trades.length) return { error: "No row had both a readable date and a result." };
  return { trades, noR, skipped };
}
function importCsv(text: string, order: "dmy" | "mdy" | null = null) {
  const acct = ACCT || accounts()[0] || "Main";
  const res = csvToTrades(text, order, acct);
  if (res.needOrder) {
    ask("The dates in this CSV could be read either way (every day is 12 or under). Which order are they in?", [
      { label: "Cancel", kind: "", value: null },
      { label: "Day / Month", kind: "", value: "dmy" },
      { label: "Month / Day", kind: "primary", value: "mdy" },
    ], (v) => { if (v) importCsv(text, v as "dmy" | "mdy"); });
    return;
  }
  if (res.error || !res.trades) { toast(res.error || "That CSV could not be read."); return; }
  const accts = Array.from(new Set(res.trades.map((t) => String(t.account))));
  const notes: string[] = [];
  if (res.skipped) notes.push(res.skipped + " rows skipped (no date or no result)");
  if (res.noR) notes.push(res.noR + " rows have P&L but no R or Risk $ - set the account's R value so they count");
  importData({ trades: res.trades as unknown as Trade[], meta: { accounts: accts } as { startBalance?: number | null } }, false, notes.join(". "));
}

// ---------- journal -> simulator ----------
// The POPULATION the simulator's edge is drawn from: one account, or all of
// them. Deliberately account-scope-only. The log's own filters (`filtered()`,
// `SEGF`, `MODELF`) are a reading aid - they change what you are looking at,
// dozens of times a session, and if they silently changed what every tab was
// computing, the odds on screen would depend on a filter you set to read one
// trade. The ONE population change that reaches the engine is EDGE_CUT below,
// which is explicit, persisted, named on screen, and answered with its own
// uncertainty. Do not wire `filtered()` into this.
function edgeScoped(): Trade[] {
  return EDGE_ACCT === "" ? JT : JT.filter((t) => accOf(t) === EDGE_ACCT);
}
// the same population with the counterfactual applied: everything except the
// segment the user asked to leave out. segMatch is the report's own predicate,
// so "Direction · Short" here means exactly the rows that row named there.
function edgeKept(): Trade[] {
  const base = edgeScoped();
  if (!EDGE_CUT) return base;
  return base.filter((t) => !segMatch(t, EDGE_CUT!.group, EDGE_CUT!.label));
}
// A counterfactual is an INSTRUCTION - it tells you what to stop doing - and the
// app already refuses to call an edge real below 30 resolved trades (Validate,
// `sim.ts`, the Funded tab's sizing tile). It must not issue one from less
// either, so a cut that would leave fewer than this is declined and the full
// record stays in force.
export const CUT_MIN_N = 30;

export interface CutStat {
  nBase: number; nKept: number; nCut: number;
  expBase: number; expKept: number; d: number;
  dLo: number; dHi: number;      // 90% bootstrap band on the CHANGE
  noise: number;                 // what a scan of look-alike segments throws up for free
  choices: number;               // how many segments that scan covered
  separable: boolean;            // the change beats BOTH bars
  enough: boolean;               // the kept record still clears CUT_MIN_N
}
function meanOf(a: number[]): number {
  if (!a.length) return 0;
  let m = 0;
  for (const r of a) m += r;
  return m / a.length;
}

// ---- bar one: is the difference bigger than sampling noise for this grouping ----
// Two independent resamples - the kept trades and the cut ones, each drawn with
// replacement at their own size - so the width reflects how few trades are being
// cut as well as how few are left. Seeded, because a confidence interval that
// flickered on re-render would be worse than none.
const CUT_BOOT = 1500;
const CUT_SEED = 7717;

// ---- bar two: is it bigger than the best segment a scan finds by accident ----
//
// The band above is NOT enough on its own, and the size of the gap was measured
// rather than guessed. On 60 records where segment membership is random by
// construction - no segment carries any signal at all - taking the worst-looking
// of ~34 segments produced an apparent gain 60 times out of 60, and the band
// alone still called 13 of them real. That is a ~78% coverage against a nominal
// 90%, arrived at independently of the design review that measured 77% and
// concluded this feature should not be built. Both bars together call 0 of the
// 60 real. `tests/unit/counterfactual.test.mjs` pins all three numbers.
//
// The band answers "is this difference bigger than sampling noise for THIS
// grouping". The grouping was chosen for being extreme, and that is the one
// thing the band cannot see.
//
// So the null is rebuilt the way the trader actually met the number: draw
// `choices` random segments of the SAME SIZE from the SAME record - membership
// independent of outcome by construction, which is the null - take the most
// striking of them, and repeat. The 95th percentile of that is what scanning the
// edge report throws up for free. A cut has to beat it.
//
// Two-sided (max |d|), because the report shows a Strengths table beside the
// Leaks one: the scan that produced the hypothesis covered both directions.
const CUT_NULL_DRAWS = 400;
const CUT_NULL_SEED = 51001;
// The bootstrap work below is written as generators that pause every CUT_SLICE
// draws. Run straight through (runGen) they are the plain functions every test
// pins, draw for draw; the Timing tab runs the same generators a few
// milliseconds at a time (separabilityAsync), because at 10,000 trades one
// candidate is over a second of work and used to freeze the window that long.
const CUT_SLICE = 20000;
function runGen<T>(g: Generator<void, T>): T {
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}
function cutNoise(all: number[], m: number, choices: number): number {
  return runGen(cutNoiseGen(all, m, choices));
}
function* cutNoiseGen(all: number[], m: number, choices: number): Generator<void, number> {
  const n = all.length;
  if (m <= 0 || m >= n) return Infinity;
  let work = 0;
  let sumAll = 0;
  for (const r of all) sumAll += r;
  const meanAll = sumAll / n;
  const rnd = mulberry(CUT_NULL_SEED);
  const idx = all.map((_, i) => i);
  // capped: the floor is already near-flat by a few hundred segments, and this
  // runs on the main thread on every firm change
  const K = Math.max(1, Math.min(500, choices));
  const best = new Array<number>(CUT_NULL_DRAWS);
  for (let b = 0; b < CUT_NULL_DRAWS; b++) {
    let mx = 0;
    for (let k = 0; k < K; k++) {
      // partial Fisher-Yates over a single reused index array: m draws without
      // replacement in O(m), no allocation, and the array stays a permutation
      // so the next draw is still uniform
      let s = 0;
      for (let i = 0; i < m; i++) {
        const j = i + ((rnd() * (n - i)) | 0);
        const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
        s += all[idx[i]];
      }
      const d = Math.abs((sumAll - s) / (n - m) - meanAll);
      if (d > mx) mx = d;
      work += m;
      if (work >= CUT_SLICE) { work = 0; yield; }
    }
    best[b] = mx;
  }
  best.sort((a, b) => a - b);
  return best[Math.min(CUT_NULL_DRAWS - 1, Math.floor(CUT_NULL_DRAWS * 0.95))];
}

// What leaving a segment out does to the record, and how much of that is the
// selection talking. `choices` is how many segments the trader could have picked
// from - the size of the scan behind the hypothesis. 1 means a single prior
// hypothesis and applies no multiplicity correction; the app passes the real
// count of the dropdown.
export function cutStat(keptRs: number[], cutRs: number[], choices = 1): CutStat {
  return runGen(cutStatGen(keptRs, cutRs, choices));
}
function* cutStatGen(keptRs: number[], cutRs: number[], choices = 1): Generator<void, CutStat> {
  const nk = keptRs.length, nc = cutRs.length, nb = nk + nc;
  const expKept = meanOf(keptRs);
  let sumB = 0;
  for (const r of keptRs) sumB += r;
  for (const r of cutRs) sumB += r;
  const expBase = nb ? sumB / nb : 0;
  const base: CutStat = {
    nBase: nb, nKept: nk, nCut: nc,
    expBase, expKept, d: expKept - expBase,
    dLo: 0, dHi: 0, noise: 0, choices: Math.max(1, choices),
    separable: false, enough: nk >= CUT_MIN_N,
  };
  // nothing cut, or nothing left: there is no difference to put a band on
  if (!nc || !nk) return base;
  const rnd = mulberry(CUT_SEED);
  const ds = new Array<number>(CUT_BOOT);
  let work = 0;
  for (let b = 0; b < CUT_BOOT; b++) {
    let sk = 0, sc = 0;
    for (let i = 0; i < nk; i++) sk += keptRs[(rnd() * nk) | 0];
    for (let i = 0; i < nc; i++) sc += cutRs[(rnd() * nc) | 0];
    ds[b] = sk / nk - (sk + sc) / nb;
    work += nb;
    if (work >= CUT_SLICE) { work = 0; yield; }
  }
  ds.sort((a, b) => a - b);
  const lo = ds[Math.floor(CUT_BOOT * 0.05)], hi = ds[Math.min(CUT_BOOT - 1, Math.floor(CUT_BOOT * 0.95))];
  base.dLo = lo; base.dHi = hi;
  base.noise = yield* cutNoiseGen(keptRs.concat(cutRs), nc, base.choices);
  // BOTH bars. The band alone lets two thirds of pure noise through; the noise
  // floor alone would call a huge but wildly uncertain difference real.
  base.separable = (lo > 0 || hi < 0) && Math.abs(base.d) > base.noise;
  return base;
}
// The two numbers a counterfactual is not allowed to be printed without: what it
// does to the odds of passing, AND what it does to the odds of still having the
// account in a year. A cut that lifts pass odds while spending survival is the
// exact trade the "best size" tile used to hide, and it is not visible from
// expectancy alone.
export interface CutOdds { passBase: number; passKept: number; survBase: number; survKept: number }
export function cutOdds(baseRs: number[], keptRs: number[], re: number, rf: number, nEval: number, nFund: number): CutOdds {
  const pass = (rs: number[]) => withEdge(rs, () => {
    const st = challengeStats(re, nEval);
    return evalPass(st);
  });
  const surv = (rs: number[]) => withEdge(rs, () => fundedStats(rf, nFund, yearSteps()).surv);
  return { passBase: pass(baseRs), passKept: pass(keptRs), survBase: surv(baseRs), survKept: surv(keptRs) };
}
// ---------- what the engine is not told by a bare list of R multiples ----------
//
// `S.trades` is a number[]. Everything about WHERE those numbers came from - the
// day each was taken on, how many accounts they were pooled from, whether two of
// them are the same bet fired into two accounts, how many subsets the user has
// already scanned - is lost at that boundary, and every one of those facts
// changes how wide the Validate tab's intervals should be. S.meta carries them.

// Trades taken on the same day are not independent observations of an edge: the
// same regime, the same mood, often the same signal. This is the day index per
// trade, parallel to the R series, so the design-effect estimator in dd.ts can
// discount for it.
function dayIndex(list: Trade[]): number[] {
  const seen = new Map<string, number>();
  return list.map((t) => {
    const d = (t.dateTime || "").slice(0, 10);
    let i = seen.get(d);
    if (i === undefined) { i = seen.size; seen.set(d, i); }
    return i;
  });
}
// Near-duplicate observations: the same instrument, same direction, entered
// within a few minutes, on DIFFERENT accounts. That is one decision recorded
// twice - the "several accounts, one strategy" case the Portfolio tab exists for
// - and counting it as two trades makes every interval on the Validate screen
// narrower than the evidence supports.
function mirroredCount(list: Trade[]): number {
  const byKey = new Map<string, string[]>();
  list.forEach((t) => {
    if (!t.instrument || !t.dateTime) return;
    // to the nearest 5 minutes: the same signal rarely fills to the same second
    const stamp = t.dateTime.slice(0, 14) + (Math.floor(Number(t.dateTime.slice(14, 16) || 0) / 5) * 5);
    const k = t.instrument + "|" + (t.direction || "") + "|" + stamp;
    const a = byKey.get(k);
    if (a) a.push(accOf(t)); else byKey.set(k, [accOf(t)]);
  });
  let dupes = 0;
  byKey.forEach((accts) => {
    if (accts.length < 2) return;
    if (new Set(accts).size > 1) dupes += accts.length - 1;
  });
  return dupes;
}
// EVERY SUBSET THE USER HAS TESTED, not just the one currently selected.
//
// The Leave-out control is a multiple-comparisons engine: each exclusion tried is
// another look at the same data, and the user will naturally keep whichever
// subset looks best. After the second look a "95% interval" is not a 95%
// interval, and nothing on screen said so. Persisted rather than held in memory
// because a reload is not a fresh experiment - the looks already happened - and
// keyed to the edge scope so switching to a different account starts its own
// count rather than inheriting another record's.
const LOOKS_KEY = "pel_edge_looks";
function looksKey(): string { return "s:" + EDGE_ACCT; }
function looksTried(): string[] {
  const all = LS.get<Record<string, string[]>>(LOOKS_KEY, {});
  return all[looksKey()] || [];
}
function noteLook(k: string) {
  const all = LS.get<Record<string, string[]>>(LOOKS_KEY, {});
  const cur = all[looksKey()] || [];
  const tag = k || "(full record)";
  if (cur.indexOf(tag) >= 0) return;
  cur.push(tag);
  all[looksKey()] = cur;
  LS.set(LOOKS_KEY, all);
}

export function applyJournalEdge() {
  const kept = edgeKept();
  const rsAll = resolvedRs(edgeScoped());
  const rsKept = resolvedRs(kept);
  // A cut that leaves too little record is declined outright rather than quietly
  // applied: refusing is the whole point of the floor, and the tabs go on
  // resampling the full record so nothing on screen is derived from 22 trades.
  const cutOn = !!EDGE_CUT && rsKept.length >= CUT_MIN_N;
  const rs = cutOn ? rsKept : rsAll;
  const scopeName = EDGE_ACCT === "" ? "all accounts" : EDGE_ACCT;
  if (rs.length < 10) {
    $i("useJournal").checked = false;
    S.trades = null;
    S.meta = null;
    $("jedgeDesc").innerHTML = "Needs <b>10</b> resolved trades in <b>" + esc(scopeName) + "</b>; you have " + rs.length + noRNote(edgeScoped()) + ".";
    hooks.render(); hooks.saveSim();
    return;
  }
  S.trades = rs;
  // The series that reached the engine, described.
  //
  // `ordered` is the same multiset in TRADE ORDER, and it is a separate array on
  // purpose. S.trades keeps the journal's own newest-first order because every
  // seeded estimator in the app draws by index from it, and reordering it would
  // move numbers on six tabs to fix a problem on one. Autocorrelation, the block
  // bootstrap and the day clustering all need chronological order, so they get
  // their own copy with `days` parallel to it.
  noteLook(cutOn ? cutKey(EDGE_CUT) : "");
  {
    const src = (cutOn ? kept : edgeScoped())
      .filter((t) => isResolved(t) && hasRBasis(t))
      .slice()
      .sort((a, b) => (a.dateTime || "").localeCompare(b.dateTime || "") || ((a.createdAt || 0) - (b.createdAt || 0)));
    const ord = src.map(tradeR).filter((r) => isFinite(r));
    S.meta = {
      scope: scopeName,
      ordered: ord.length === rs.length ? ord : null,
      days: ord.length === rs.length ? dayIndex(src) : null,
      accounts: new Set(src.map(accOf)).size,
      mirrored: mirroredCount(src),
      cutName: cutOn ? EDGE_CUT!.group + " · " + EDGE_CUT!.label : null,
      looks: looksTried().length,
      fullRs: cutOn ? rsAll : null,
    };
  }
  // Display-only: with trades set, every sim resamples the R list itself, so a
  // 0R scratch enters the engine as the zero it is. The quoted win% matches the
  // journal's convention - wins over decided trades, scratches in neither column
  // - and S.s carries the scratch share so the readout and any later slider
  // hand-off describe the same three-outcome record.
  const wins = rs.filter((r) => r > 0.0001).length;
  const losses = rs.filter((r) => r < -0.0001).length;
  S.p = wins + losses ? wins / (wins + losses) : 0;
  S.s = rs.length ? (rs.length - wins - losses) / rs.length : 0;
  S.n = rs.length;
  // EVERY control, not two of them.
  //
  // This used to write nwr and nn only, so the win-rate SLIDER kept its old thumb
  // position while the box beside it showed the journal's figure, and the scratch
  // and reward-to-risk controls kept whatever the user last dragged - greyed out,
  // still legible, and describing a different edge from the one every tab was
  // computing. That is how the sidebar came to show "win 56 / R:R 2.1 / scratch
  // 16" above a panel reading "56% of decided, 10% scratch": three of the four
  // controls were stale, and the one nobody could see was stale was the payoff.
  //
  // The payoff control is the subtle one. When S.trades is set, sampleR resamples
  // the record and IGNORES S.b entirely - so whatever that slider said, the engine
  // was not using it. Rather than blank it, it now shows the record's own measured
  // payoff (average winner / average loser), which is the quantity the journal's
  // Stats tab already prints as R:R. The control is then true, disabled, and
  // agrees with the other half of the app.
  let gw = 0, nw = 0, gl = 0, nl = 0;
  rs.forEach((r) => { if (r > 0.0001) { gw += r; nw++; } else if (r < -0.0001) { gl -= r; nl++; } });
  const rrMeasured = nw && nl && gl > 0 ? gw / nw / (gl / nl) : 0;
  const pfMeasured = gl > 0 ? gw / gl : 0;
  const shown = S.payMode === "pf" ? pfMeasured : rrMeasured;
  // Writing the same string to both halves is not enough: a range input SNAPS to
  // its step, so "102" became 100 on a slider stepping by 10 and "1.77" became
  // 1.75 on one stepping by 0.05 - the thumb and the box beside it disagreed by
  // exactly the amount the step could not express. While the journal drives, these
  // are read-only readouts of a measured record, so they get a step fine enough to
  // hold it, and a range wide enough if the record is bigger than the slider was
  // built for. clearJournalEdge puts the editable geometry back.
  const setPair = (rangeId: string, numId: string, v: string, step: string) => {
    const r = $i(rangeId), b = $i(numId);
    r.step = step; b.step = step;
    if (Number(v) > Number(r.max)) { r.max = v; b.max = v; }
    if (Number(v) < Number(r.min)) { r.min = v; b.min = v; }
    r.value = v; b.value = v;
  };
  setPair("swr", "nwr", String(Math.round(S.p * 100)), "1");
  setPair("sn", "nn", String(S.n), "1");
  setPair("ssc", "nsc", String(Math.round(S.s * 100)), "1");
  if (shown > 0) setPair("spay", "npay", shown.toFixed(2), "0.01");
  ["swr", "spay", "sn", "ssc", "nwr", "npay", "nn", "nsc"].forEach((id) => { $i(id).disabled = true; });
  $("edgeBar").classList.add("jlocked");
  let ev = 0;
  rs.forEach((r) => { ev += r; });
  ev /= rs.length;
  // NAME THE GAP. The engine's population is resolved AND carrying a risk basis;
  // the journal's own Stats tab counts every resolved trade, basis or not. Both
  // are right for their own question (a P&L-only row's SIGN is data, its
  // MAGNITUDE is not - Trap #2), but when they differ the app was quietly showing
  // two different trade counts for one journal and calling both "your trades".
  // Where the two populations coincide this says nothing extra.
  const excluded = noRBasisCount(cutOn ? kept : edgeScoped());
  $("jedgeDesc").innerHTML = "On &mdash; <b>" + rs.length + "</b> trades from <b>" + esc(scopeName) + "</b>" +
    (cutOn ? " <b>without " + esc(EDGE_CUT!.group + " · " + EDGE_CUT!.label) + "</b>" : "") +
    (excluded > 0 ? " &middot; " + excluded + " without R left out" : "") + ".";
  hooks.render(); hooks.saveSim();
}
export function clearJournalEdge() {
  S.trades = null;
  // a slider edge is iid by construction, has no dates, no accounts and nobody
  // has scanned any subsets of it - so the honest meta is none at all
  S.meta = null;
  // Switching OFF has to hand the engine back to the SLIDERS, not leave it on the
  // p/b/n/s applyJournalEdge wrote into S while the journal was driving. Without
  // this the app went on computing from a phantom edge that was neither the
  // journal's (S.trades is gone) nor the sliders' (they still read whatever they
  // read before), and nothing on screen described the state it was actually in.
  //
  // Through the ONE reader, not four hand-rolled ones. This block used to read
  // #spay straight into S.b, which is only correct in reward-to-risk mode: with
  // the Profit factor toggle active it installed a profit factor AS a payoff
  // ratio, so turning the journal edge off silently re-priced the sliders' own
  // edge. syncSliders() has honoured S.payMode since the toggle shipped; it is
  // reached through `hooks` because journal.ts cannot import sim.ts (import cycle
  // - that is what the hooks object exists for). The inputs are re-enabled FIRST
  // because syncSliders reads them.
  ["swr", "spay", "sn", "ssc", "nwr", "npay", "nn", "nsc"].forEach((id) => { $i(id).disabled = false; });
  $("edgeBar").classList.remove("jlocked");
  // ...and the EDITABLE geometry, which applyJournalEdge widened so the readouts
  // could hold the record exactly. These are the values index.html ships; the
  // payoff pair is owned by the R:R / Profit-factor toggle, so it is restored to
  // whichever mode is in force rather than to a fixed guess.
  const restore = (rangeId: string, numId: string, min: string, max: string, step: string) => {
    const r = $i(rangeId), b = $i(numId);
    r.min = min; r.max = max; r.step = step;
    b.min = min; b.max = max; b.step = step;
    const v = String(Math.max(Number(min), Math.min(Number(max), Number(r.value))));
    r.value = v; b.value = r.value;   // read back: the range re-snaps to its step
  };
  restore("swr", "nwr", "0", "100", "1");
  restore("sn", "nn", "10", "1500", "10");
  restore("ssc", "nsc", "0", "60", "1");
  if (S.payMode === "pf") restore("spay", "npay", "0.5", "8", "0.02");
  else restore("spay", "npay", "0.5", "6", "0.05");
  hooks.syncSliders();
  $("jedgeDesc").innerHTML = "Off &mdash; using the sliders.";
  renderEdgeCut();
  hooks.render(); hooks.saveSim();
}

// ---------- the counterfactual ----------
// Every segment you could leave out, in the edge report's own families, so a row
// you read there is a row you can test here. The counts come from segMatch - the
// same predicate the cut itself uses - so the number on the option and the
// number actually removed can never disagree.
function cutSegments(): { segs: { group: string; label: string; n: number }[]; total: number } {
  const res = edgeScoped().filter((t) => isResolved(t) && hasRBasis(t));
  const cand: SegRef[] = [];
  const push = (group: string, labels: string[]) => labels.forEach((label) => cand.push({ group, label }));
  push("Direction", ["Long", "Short"]);
  push("Session", SESSIONS.slice());
  const mods: Record<string, 1> = {};
  res.forEach((t) => { mods[modelLbl(modelOf(t))] = 1; });
  push("Entry model", Object.keys(mods).sort());
  const syms: Record<string, 1> = {};
  res.forEach((t) => { if (t.instrument) syms[t.instrument] = 1; });
  push("Instrument", Object.keys(syms).sort());
  push("Grade", QUALITY.slice());
  push("Regime", CONDITIONS.slice());
  push("Emotion", ["Calm entry (1-2)", "Elevated entry (4-5)"]);
  push("Discipline", ["Followed plan", "Broke plan", "Clean (no mistakes)"]);
  push("Mistake", MISTAKES.slice());
  const segs: { group: string; label: string; n: number }[] = [];
  cand.forEach((c) => {
    let n = 0;
    res.forEach((t) => { if (segMatch(t, c.group, c.label)) n++; });
    if (n > 0) segs.push({ group: c.group, label: c.label, n });
  });
  return { segs, total: res.length };
}
// The option VALUE, as JSON rather than "group + separator + label". Group names
// contain spaces ("Entry model") and labels are free text (instrument symbols,
// entry-model names), so every printable delimiter can be produced by the data
// and would split the wrong field. JSON has no such seam, the key order is fixed
// so the string round-trips, and it compares as a plain string.
function cutKey(c: SegRef | null): string { return c ? JSON.stringify({ group: c.group, label: c.label }) : ""; }
function cutParse(v: string): SegRef | null {
  if (!v) return null;
  try {
    const o = JSON.parse(v) as SegRef;
    return o && typeof o.group === "string" && typeof o.label === "string" ? { group: o.group, label: o.label } : null;
  } catch { return null; }
}
function refreshEdgeCutSel() {
  const sel = document.getElementById("jEdgeCut") as HTMLSelectElement | null;
  if (!sel) return;
  const { segs } = cutSegments();
  const cur = cutKey(EDGE_CUT);
  // A segment that no longer has a single trade in scope is gone - the account
  // was switched, the trades deleted, the tag renamed - and a cut nothing can
  // match would silently be a no-op.
  if (cur && !segs.some((s) => cutKey(s) === cur)) { EDGE_CUT = null; LS.set("pel_edge_cut", cutKey(null)); }
  // 4 is the edge report's own floor for naming a segment at all. Note what is
  // NOT filtered here: a segment that would leave too little record behind is
  // still offered, and answered with the refusal. Hiding it made a 40-trade
  // account silently have no "Direction · Short" option and no reason given -
  // the trader asks the question and the app appears not to have heard it.
  // An option that explains why it declines beats an option that is not there.
  const offer = segs.filter((s) => s.n >= 4 || cutKey(s) === cutKey(EDGE_CUT));
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = ""; none.textContent = "Nothing — my whole record";
  sel.appendChild(none);
  offer.forEach((s) => {
    const o = document.createElement("option");
    o.value = cutKey(s);
    o.textContent = s.group + " · " + s.label + " (" + s.n + ")";
    sel.appendChild(o);
  });
  sel.value = cutKey(EDGE_CUT);
  sel.disabled = offer.length === 0;
}
// Scoring two populations against the firm is real Monte Carlo, so it caches on
// everything that can move it and reuses the last answer while a slider is being
// dragged - the same two-tier rule the profit curves follow.
let cutCache: { key: string; html: string } | null = null;
export function renderEdgeCut(fast?: boolean) {
  const box = document.getElementById("jedgeCut");
  if (!box) return;
  const off = () => { box.className = "cutbox hide"; box.innerHTML = ""; cutCache = null; };
  const uj = document.getElementById("useJournal") as HTMLInputElement | null;
  if (!uj || !uj.checked || !EDGE_CUT) { off(); return; }
  // Everything above the cache check has to stay cheap: this runs on EVERY sim
  // render, on every tab, including mid-drag. Splitting the R lists is O(n);
  // cutStat is ~half a million operations and cutOdds is 1200 Monte Carlos, and
  // both sit below the key.
  const base = edgeScoped();
  const cutT = base.filter((t) => segMatch(t, EDGE_CUT!.group, EDGE_CUT!.label));
  const baseRs = resolvedRs(base), keptRs = resolvedRs(edgeKept()), cutRs = resolvedRs(cutT);
  const name = esc(EDGE_CUT.group + " · " + EDGE_CUT.label);
  if (keptRs.length < CUT_MIN_N) {
    // the floor, stated as a refusal rather than a smaller number. No statistic
    // is computed for it - there is nothing to say about a record this thin
    // beyond that it is too thin.
    box.className = "cutbox warn";
    box.innerHTML = '<p class="ch">Not applied &mdash; without <b>' + name + '</b> only <b>' + keptRs.length +
      "</b> trades left (needs " + CUT_MIN_N + ").</p>";
    cutCache = null;
    return;
  }
  const re = Number($i("src").value), rf = Number($i("srf").value);
  let sk = 0;
  keptRs.forEach((r) => { sk += r; });
  const key = firmKey(F) + "|" + re + "|" + rf + "|" + baseRs.length + "/" + keptRs.length + "|" + sk.toFixed(3);
  if (cutCache && cutCache.key === key) { box.className = "cutbox"; box.innerHTML = cutCache.html; return; }
  // mid-drag: show the last good answer rather than spend 1200 sims per frame
  if (fast && cutCache) { box.className = "cutbox"; box.innerHTML = cutCache.html; return; }
  // the size of the scan behind the hypothesis: every way this record can be
  // sliced is one the trader could have landed on instead, and the noise floor
  // has to know how many that was
  const cs = cutStat(keptRs, cutRs, cutSegments().segs.length);
  const od = cutOdds(baseRs, keptRs, re, rf, 800, 400);
  const sR = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(2) + "R";
  const arrow = (a: string, b: string, better: boolean | null) =>
    '<td class="was">' + a + '</td><td class="now ' + (better === null ? "" : better ? "cell-go" : "cell-stop") + '">' + b + "</td>";
  const survDrop = od.survKept < od.survBase - 0.02;
  const thin = cs.nKept < 100;
  const html =
    '<p class="ch">Your record without <b>' + name + "</b></p>" +
    '<table class="cuttab"><thead><tr><th>&nbsp;</th><th>now</th><th>without</th></tr></thead><tbody>' +
    "<tr><td>measurable trades</td>" + arrow(String(cs.nBase), String(cs.nKept), null) + "</tr>" +
    "<tr><td>expectancy</td>" + arrow(sR(cs.expBase), sR(cs.expKept), cs.expKept >= cs.expBase) + "</tr>" +
    "<tr><td>pass the eval</td>" + arrow(pctEst(od.passBase), pctEst(od.passKept), od.passKept >= od.passBase) + "</tr>" +
    // the survival row is not optional. A cut that lifts the pass odds while
    // spending account life is the same mistake the "best size" tile used to
    // make, and it is invisible from expectancy or pass odds alone.
    "<tr><td>stay funded 1yr</td>" + arrow(pctEst(od.survBase), pctEst(od.survKept), od.survKept >= od.survBase) + "</tr>" +
    "</tbody></table>" +
    '<p class="cv-band">change in expectancy <b>' + sR(cs.d) + "</b> &middot; 90% band " + sR(cs.dLo) + " to " + sR(cs.dHi) +
    "<br>noise floor &plusmn;" + cs.noise.toFixed(2) + "R across " + cs.choices + " ways to slice this record</p>" +
    // The two bars, said in words. The floor is the part a trader has never been
    // shown anywhere else: cutting the most striking of thirty-odd buckets moves
    // a record by THIS much on a journal where nothing is going on at all.
    '<p class="cv-note">' + (cs.separable
      ? "<b>Stands out</b> from the noise. Still a hypothesis &mdash; trade it forward."
      : Math.abs(cs.d) < 0.02 ? "Barely moves the record."
        : Math.abs(cs.d) <= cs.noise ? "Inside the noise floor." : "Band includes zero &mdash; could be luck.") +
    (survDrop ? ' <b class="cell-stop">Survival drops</b> ' + pctEst(od.survBase) + " &rarr; " + pctEst(od.survKept) + "." : "") +
    (thin ? " Under 100 trades." : "") + "</p>";
  cutCache = { key, html };
  box.className = "cutbox";
  box.innerHTML = html;
}

// ---------- top-level render + wiring ----------
function setJView(v: string) {
  JVIEW = v;
  document.querySelectorAll<HTMLButtonElement>(".subnav button[data-jview]").forEach((x) =>
    x.setAttribute("aria-pressed", x.getAttribute("data-jview") === v ? "true" : "false"));
  $("jv-log").classList.toggle("hide", v !== "log");
  $("jSummary").classList.toggle("hide", v !== "log");
  $("jv-stats").classList.toggle("hide", v !== "stats");
  $("logTools").style.display = v === "log" ? "flex" : "none";
  syncUnitSeg();
  if (v !== "log" && SELMODE) { SELMODE = false; SEL.clear(); updateSelUI(); }
}
export function renderJournal() {
  // the dollar layer's default is derived from the data, so it is recomputed
  // once per render rather than per surface (JT.some is O(n))
  refreshDollarData();
  refreshSetups();
  renderSummary();
  renderRuleGuard();
  if (JVIEW === "stats") renderStats(); else renderLog();
}
export function loadTrades(cb?: () => void) {
  Store.loadAll((list, meta) => {
    list.forEach((t) => { t._R = computeR(t); });
    list.sort((a, b) => (b.dateTime || "").localeCompare(a.dateTime || ""));
    JT = list;
    const src = Store.kind === "file" ? meta : LS.get<JMeta | null>("pel_jmeta", null);
    if (src) {
      if (src.startBalance != null && isFinite(Number(src.startBalance))) JMETA.startBalance = Number(src.startBalance);
      if (Array.isArray(src.accounts) && src.accounts.length) JMETA.accounts = src.accounts.slice();
      if (src.balances && typeof src.balances === "object") JMETA.balances = { ...src.balances };
      if (src.accountFirms && typeof src.accountFirms === "object") JMETA.accountFirms = { ...src.accountFirms };
      // the phase store rides BESIDE accountFirms and must survive a restart the
      // same way - without this line every funded flag died on relaunch and the
      // rule guard silently reverted to eval meters over the full history
      if (src.accountPhase && typeof src.accountPhase === "object") {
        JMETA.accountPhase = {};
        Object.keys(src.accountPhase).forEach((k) => {
          const v = (src.accountPhase as Record<string, { phase?: string; since?: string }>)[k];
          if (v && (v.phase === "eval" || v.phase === "funded")) {
            JMETA.accountPhase![k] = { phase: v.phase, ...(typeof v.since === "string" ? { since: v.since } : {}) };
          }
        });
      }
      // the dollar basis rides beside balances and must survive a restart the same
      // way accountPhase does - without this the $ layer silently switches itself
      // off on every relaunch and the journal falls back to R-only
      if (src.rBasis && typeof src.rBasis === "object") {
        JMETA.rBasis = {};
        Object.keys(src.rBasis).forEach((k) => {
          const b = sanitizeRBasis((src.rBasis as Record<string, unknown>)[k]);
          if (b) JMETA.rBasis![k] = b;
        });
      }
      if (src.lastAutoBackup != null && isFinite(Number(src.lastAutoBackup))) JMETA.lastAutoBackup = Number(src.lastAutoBackup);
    }
    normalizeMeta();
    renderAcctSel();
    JLOADED = true;
    cb && cb();
  });
}

export function wireJournal() {
  // instrument dropdown
  const sel = $s("edSymSel");
  const o0 = document.createElement("option");
  o0.value = ""; o0.textContent = "Select…";
  sel.appendChild(o0);
  Object.keys(INSTRUMENTS).forEach((g) => {
    const og = document.createElement("optgroup");
    og.label = g;
    INSTRUMENTS[g].forEach((s) => { const o = document.createElement("option"); o.value = s; o.textContent = s; og.appendChild(o); });
    sel.appendChild(og);
  });
  const oc = document.createElement("option");
  oc.value = "__custom"; oc.textContent = "Custom…";
  sel.appendChild(oc);
  sel.addEventListener("change", function () {
    const c = this.value === "__custom";
    $("edSymCustomWrap").classList.toggle("hide", !c);
    if (c) $i("edSym").focus();
  });

  // setup + entry model: typed fields that also offer what you have used before
  wireCombo("edSetup", "cbSetupTog");
  wireCombo("edModel", "cbModelTog");

  chipset("edQuality", QUALITY, "q");
  chipset("edMistakes", MISTAKES, "m");
  chipset("edConditions", CONDITIONS, "");
  emorow("edEmoB"); emorow("edEmoA");
  document.querySelectorAll<HTMLButtonElement>(".seg button[data-plan]").forEach((b) =>
    b.addEventListener("click", () =>
      document.querySelectorAll<HTMLButtonElement>(".seg button[data-plan]").forEach((x) =>
        x.setAttribute("aria-pressed", x === b ? "true" : "false"))));

  $("edClose").addEventListener("click", () => closeEditor(false));
  $("edCancel").addEventListener("click", () => closeEditor(false));
  $("edSave").addEventListener("click", saveTrade);
  $("edDelete").addEventListener("click", () => { if (EDIT_ID) deleteTrade(EDIT_ID); });
  // Explicit clipboard read. WKWebView only turns Cmd+V into a document `paste`
  // event when focus is in an editable element, and the editor opens focused on a
  // <select> - so on macOS the keyboard path can silently do nothing. This button
  // does not depend on focus at all, and is a clearer affordance on every platform.
  $("edPasteBtn").addEventListener("click", () => {
    const nav = navigator as Navigator & { clipboard?: { read?: () => Promise<ClipboardItem[]> } };
    if (!nav.clipboard || !nav.clipboard.read) { toast("This build cannot read the clipboard directly - drag the image in, or use the file picker."); return; }
    nav.clipboard.read().then((items) => {
      const files: File[] = [];
      items.forEach((it, i) => {
        const type = it.types.find((t) => t.indexOf("image") === 0);
        if (!type) return;
        it.getType(type).then((blob) => {
          files.push(new File([blob], "clipboard-" + (i + 1) + "." + type.split("/")[1], { type }));
          addFiles(files.splice(0));
        });
      });
      if (!items.some((it) => it.types.some((t) => t.indexOf("image") === 0))) toast("No image on the clipboard - copy a chart first.");
    }).catch(() => toast("Clipboard access was refused - drag the image in, or use the file picker."));
  });
  $("edDrop").addEventListener("click", () => $i("edFiles").click());
  $("edDrop").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $i("edFiles").click(); } });
  $i("edFiles").addEventListener("change", function () { if (this.files) addFiles(this.files); this.value = ""; });
  const dz = $("edDrop");
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("drag"); if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });
  // A drop that MISSES the dropzone is otherwise handled by the browser, which
  // navigates the window to the dropped file - taking the open editor and every
  // unsaved edit with it. Swallow drops anywhere else in the app; a near-miss on
  // the dropzone while the editor is open is clearly meant for it.
  document.addEventListener("dragover", (e) => { if (e.dataTransfer) e.preventDefault(); });
  document.addEventListener("drop", (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    const editorOpen = !$("editorOv").classList.contains("hide");
    if (editorOpen && e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      addFiles(e.dataTransfer.files);
      toast("Added to this trade - drop on the dashed box next time.");
    }
  });
  document.addEventListener("paste", (e) => {
    if ($("editorOv").classList.contains("hide")) return;
    if (!e.clipboardData) return;
    const items = e.clipboardData.items, got: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf("image") >= 0) { const f = items[i].getAsFile(); if (f) got.push(f); }
    }
    if (got.length) { e.preventDefault(); addFiles(got); }
  });
  $("editorOv").addEventListener("mousedown", function (e) { if (e.target === this) closeEditor(false); });
  $("detailOv").addEventListener("mousedown", function (e) { if (e.target === this) this.classList.add("hide"); });
  wireLightbox();
  document.addEventListener("keydown", (e) => {
    // the lightbox sits on top: it owns the arrows and zoom keys while open
    if (!$("lightbox").classList.contains("hide")) {
      if (e.key === "ArrowLeft") { e.preventDefault(); lbNav(-1); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); lbNav(1); return; }
      if (e.key === "+" || e.key === "=") { e.preventDefault(); lbZoomAt(1.35); return; }
      if (e.key === "-" || e.key === "_") { e.preventDefault(); lbZoomAt(1 / 1.35); return; }
      if (e.key === "0") { e.preventDefault(); lbFit(); return; }
    }
    if (e.key === "Escape") {
      if (!$("lightbox").classList.contains("hide")) { lbClose(); return; }
      if (!$("askOv").classList.contains("hide")) return;
      if (!$("editorOv").classList.contains("hide")) { closeEditor(false); return; }
      if (!$("detailOv").classList.contains("hide")) { $("detailOv").classList.add("hide"); return; }
      if (SELMODE) { setSelMode(false); return; }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !$("editorOv").classList.contains("hide")) { e.preventDefault(); saveTrade(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === "n" || e.key === "N") && hooks.getMode() === "journal" && $("editorOv").classList.contains("hide") && $("detailOv").classList.contains("hide")) { e.preventDefault(); openEditor(null); }
    // flip through trades while the detail view is open (lightbox handled above)
    if (!$("detailOv").classList.contains("hide") && $("editorOv").classList.contains("hide") && $("askOv").classList.contains("hide") && $("lightbox").classList.contains("hide")) {
      if (e.key === "ArrowLeft") { e.preventDefault(); detailNav(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); detailNav(1); }
    }
  });

  ["edR", "edRisk", "edEntry", "edStop", "edTarget", "edExit", "edFees", "edDate", "edExitTime", "edMfeIn", "edMaeIn"].forEach((id) => $(id).addEventListener("input", liveR));
  $s("edDir").addEventListener("change", liveR);
  document.querySelectorAll<HTMLButtonElement>("button[data-exu]").forEach((b) =>
    b.addEventListener("click", () => { setExUnit(b.getAttribute("data-exu")!); liveR(); }));
  // P&L owns its own handler: the typed/auto flag has to be set before liveR
  // runs, or autoPnl() overwrites the number the moment it is typed
  $i("edPnl").addEventListener("input", function () {
    if (this.value === "") { delete this.dataset.manual; delete this.dataset.auto; }
    else { this.dataset.manual = "1"; delete this.dataset.auto; }
    liveR();
  });

  document.querySelectorAll<HTMLButtonElement>(".subnav button[data-jview]").forEach((b) =>
    b.addEventListener("click", () => { setJView(b.getAttribute("data-jview")!); renderJournal(); }));
  // journal-wide unit switch (R / P&L / Both)
  document.querySelectorAll<HTMLButtonElement>("button[data-unit]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.getAttribute("data-unit") === JUNIT));
    b.addEventListener("click", () => setUnit(b.getAttribute("data-unit") as CalUnit));
  });
  $("jNew").addEventListener("click", () => openEditor(null));
  $("jExport").addEventListener("click", doExport);
  $("jImport").addEventListener("click", () => $i("jImportFile").click());
  $i("jImportFile").addEventListener("change", function () { if (this.files && this.files[0]) doImport(this.files[0]); this.value = ""; });
  // the fixed mistake/condition vocabularies double as filters
  $s("fltMistake").innerHTML = '<option value="">Any</option>' + MISTAKES.map((m) => '<option value="' + esc(m) + '">' + esc(m) + "</option>").join("");
  $s("fltCond").innerHTML = '<option value="">Any</option>' + CONDITIONS.map((c) => '<option value="' + esc(c) + '">' + esc(c) + "</option>").join("");
  // typed filters coalesce: a burst of keystrokes used to re-render the whole
  // log (and re-scan every thumbnail) on every character
  let fltT: ReturnType<typeof setTimeout> | null = null;
  const filterTyped = () => {
    if (fltT) clearTimeout(fltT);
    fltT = setTimeout(() => { fltT = null; renderJournal(); }, 160);
  };
  ["fltText", "fltSym", "fltFrom", "fltTo"].forEach((id) => $(id).addEventListener("input", filterTyped));
  ["fltSetup", "fltOutcome", "fltDir", "fltSess", "fltMistake", "fltCond"].forEach((id) => $(id).addEventListener("input", () => renderJournal()));
  const fltOpen = (o: boolean) => {
    $("fltBar").classList.toggle("open", o);
    $("fltToggle").setAttribute("aria-expanded", String(o));
    LS.set("pel_flt_open", o);
  };
  fltOpen(LS.get<boolean>("pel_flt_open", false));
  $("fltToggle").addEventListener("click", () => fltOpen(!$("fltBar").classList.contains("open")));
  $("jClearFilter").addEventListener("click", () => {
    ["fltText", "fltSetup", "fltOutcome", "fltDir", "fltSess", "fltMistake", "fltCond", "fltSym", "fltFrom", "fltTo"].forEach((id) => { ($(id) as HTMLInputElement).value = ""; });
    MODELF.clear();
    clearSeg();
    renderJournal();
  });
  $("jReveal").addEventListener("click", () => { if (TAURI) TAURI("reveal_data_dir"); });
  document.querySelectorAll<HTMLButtonElement>("button[data-dens]").forEach((b) =>
    b.addEventListener("click", () => { LOG_DENSE = b.getAttribute("data-dens") === "compact"; LS.set("pel_log_dense", LOG_DENSE); renderLog(); }));
  $("rgBind").addEventListener("click", bindFirm);
  $("rgUnbind").addEventListener("click", unbindFirm);
  $("rgPhaseEval").addEventListener("click", () => { if (ACCT !== "") setPhase(ACCT, "eval"); });
  $("rgPhaseFunded").addEventListener("click", () => { if (ACCT !== "") setPhase(ACCT, "funded"); });
  $("edModeBtn").addEventListener("click", () => { ED_QUICK = !ED_QUICK; LS.set("pel_ed_quick", ED_QUICK); applyEdMode(); });
  $("dtClose").addEventListener("click", () => $("detailOv").classList.add("hide"));
  $("dtCloseB").addEventListener("click", () => $("detailOv").classList.add("hide"));
  $("dtPrev").addEventListener("click", () => detailNav(-1));
  $("dtNext").addEventListener("click", () => detailNav(1));
  $("dtEdit").addEventListener("click", () => { $("detailOv").classList.add("hide"); if (DETAIL_ID) openEditor(DETAIL_ID); });
  $("dtDelete").addEventListener("click", () => { if (DETAIL_ID) deleteTrade(DETAIL_ID); });

  let balT: ReturnType<typeof setTimeout> | null = null;
  $i("jStartBal").addEventListener("input", function () {
    if (ACCT === "") return; // combined view: balances are set per account
    const v = this.value === "" ? null : Number(this.value);
    JMETA.balances = JMETA.balances || {};
    JMETA.balances[ACCT] = v;
    if (ACCT === "Main") JMETA.startBalance = v; // keep legacy field in sync for old backups
    if (balT) clearTimeout(balT);
    balT = setTimeout(saveMeta, 400);
    renderSummary();
    renderRuleGuard();   // a "% of start" R value re-prices every meter off this
    if (JVIEW === "stats") renderStats();
  });
  let rvT: ReturnType<typeof setTimeout> | null = null;
  $i("jRVal").addEventListener("input", () => {
    if (rvT) clearTimeout(rvT);
    rvT = setTimeout(setRBasis, 350);
  });
  // Flipping $ per R <-> % of start CONVERTS the number through the starting
  // balance - the contract the MFE/MAE unit switch already keeps: a unit
  // switch re-expresses a value, it never reinterprets the digits. Leaving the
  // digits in place silently turned "20200 $ per R" into "20200% of start",
  // i.e. 1R = $10.1M on a $50k account, in one click with no message. With no
  // starting balance there is nothing to convert through, so the box clears
  // and says why instead of guessing.
  const setRMode = (pct: boolean) => {
    const was = $("jRModePct").getAttribute("aria-pressed") === "true";
    if (was !== pct) {
      const box = $i("jRVal");
      const n = box.value === "" ? null : Number(box.value);
      if (n != null && isFinite(n) && n > 0) {
        const b = scopeStart();
        if (b != null && b > 0) box.value = String(Math.round((pct ? (n / b) * 100 : (n * b) / 100) * 10000) / 10000);
        else { box.value = ""; toast("Cleared the R value — converting between $ and % needs a starting balance for this account."); }
      }
    }
    $("jRModeFixed").setAttribute("aria-pressed", String(!pct));
    $("jRModePct").setAttribute("aria-pressed", String(pct));
    setRBasis();
  };
  $("jRModeFixed").addEventListener("click", () => setRMode(false));
  $("jRModePct").addEventListener("click", () => setRMode(true));
  $("jDollarBtn").addEventListener("click", () => {
    DOLLARS_CHOICE = !dollarsOn();
    LS.set("pel_dollars_open", DOLLARS_CHOICE);
    // a full repaint: the switch now governs the summary tiles, the equity line,
    // the unit segment AND the log/calendar units, not just the R-value box
    renderJournal();
  });
  $s("jAcct").addEventListener("change", function () { setScope(this.value); });
  $("jNewAcct").addEventListener("click", newAccountFlow);
  $("jDelAcct").addEventListener("click", deleteAccountFlow);
  $("jSelMode").addEventListener("click", () => setSelMode(!SELMODE));
  $("jSelAll").addEventListener("click", () => { if (!SELMODE) return; LOG_SHOWN.forEach((id) => SEL.add(id)); updateSelUI(); renderLog(); });
  $("jDelSel").addEventListener("click", bulkDelete);
  $s("jEdgeAcct").addEventListener("change", function () {
    EDGE_ACCT = this.value;
    LS.set("pel_edge_acct", EDGE_ACCT);
    // the cut is named against the trades in the old scope; rebuild the list
    // before re-feeding the engine or a stale cut can survive the switch
    refreshEdgeCutSel();
    if ($i("useJournal").checked) applyJournalEdge(); else renderEdgeCut();
  });
  $s("jEdgeCut").addEventListener("change", function () {
    EDGE_CUT = cutParse(this.value);
    LS.set("pel_edge_cut", cutKey(EDGE_CUT));
    if ($i("useJournal").checked) applyJournalEdge(); else renderEdgeCut();
  });
  $s("edAcct").addEventListener("change", () => { prefillRisk(); liveR(); });
  // typing in the box takes it off the account default, the same way a hand-typed
  // P&L outranks the prices (Trap #6)
  $i("edRisk").addEventListener("input", function () { delete this.dataset.auto; });

  if (Store.kind === "file") {
    $("jStorageNote").innerHTML = "";
  } else {
    $("jStorageNote").innerHTML = "Stored in this browser only &mdash; <b>export backups often</b>.";
  }
}
