// mutable app state singletons + firm presets + money formatting

// Drawdown mode. "trailing" keeps its original meaning - trails the highest
// equity tick, intraday - so every preset, saved custom firm and account-bound
// firm written before 2.2 keeps behaving exactly as it did. "trailing-eod"
// trails only the end-of-day closed balance, which is a materially easier rule:
// an intraday spike you give back never raises the floor.
export type DdType = "static" | "trailing" | "trailing-eod";

export interface Firm {
  name?: string;
  type: "2step" | "1phase" | "futures";
  account: number; p1: number; p2: number; maxdd: number;
  ddType: DdType; ddLock: number; daily: number;
  minDays: number; cons: number; tpd: number; split: number; fee: number;
  // --- all optional: absent means "as it behaved before 2.2", so old saves load unchanged ---
  timeLimit?: number;              // eval days allowed; 0 / absent = no time limit
  feeMode?: "once" | "monthly";    // monthly = a subscription that keeps charging until you pass
  activation?: number;             // one-off fee to convert to a funded account
  instant?: boolean;               // instantly funded: the fee buys the account, there is no evaluation
  // --- payout cadence. Unwithdrawn profit is still exposed to the drawdown, so
  // a firm that pays monthly leaves you carrying far more forfeiture risk than
  // one that pays daily. All three default to 0 = "withdraw whenever you like".
  payoutMin?: number;              // minimum withdrawal in dollars
  payoutEvery?: number;            // trading days between payout windows (0 = on demand)
  payoutFirst?: number;            // trading days on the funded account before the FIRST payout
  // --- payout GATES (2.8.0). These are modelled in BOTH the first-payout odds
  // and the funded cash-flow, because they are hard mechanics of when money may
  // leave, not scheduling preferences. All default 0 = off = the engine streams
  // are bit-identical to pre-gate builds. The counterparty cost of the profit
  // these rules force you to leave at the firm is priced by the USER's haircut
  // slider, never invented here - see the note on fundedSim.
  payoutBuffer?: number;           // $ of profit the account must hold before ANY withdrawal is allowed
  payoutCap?: number;              // max % of current profit withdrawable per payout (0 = uncapped)
  // FIXED dollar ceiling per payout request. Researched 2026-08-03: this is the
  // COMMONEST real payout rule in futures prop (Apex, Topstep, Tradeify Growth
  // and Lightning, Goat, Funded Futures Network, Earn2Trade, Alpha Futures all
  // use one), and it is not a percentage - the firms that cap by % are the
  // minority. Modelling only the % cap would have left the majority rule
  // invisible. Where a firm tiers the cap by payout number ($1.5k, $2k, $2.5k,
  // $3k...), the FIRST tier is catalogued and the ladder noted, because the
  // first payout is the one most traders are pricing.
  payoutCapAmt?: number;           // max $ per payout request (0 = no fixed ceiling)
  // CONSISTENCY payout gate: the largest share of profit-since-the-last-payout
  // that any single trading day may contribute, checked when a payout is
  // REQUESTED. Distinct from `cons`, which is the same shape of rule applied to
  // the EVALUATION target. Researched 2026-08-04: 9 of 23 catalogued firms run
  // one (Topstep 50, Apex 50, Tradeify 20-35, E8 40, FFN 40, Alpha Futures 40,
  // Alpha Capital 40, Funded Trading Plus 50, The5ers unpublished), which made
  // it the commonest unmodelled rule left. A big day does NOT fail the account:
  // it blocks withdrawals until further profit dilutes it below the threshold,
  // which is exactly a delay - so the first-payout leg keeps its provable sign.
  payoutCons?: number;             // max % of profit-since-last-payout from one day (0 = no rule)
  winDays?: number;                // trading days with day-P&L >= winAmt required before a payout
  winAmt?: number;                 // the per-day profit ($) a day must clear to count as a winning day
  resetFee?: number;               // discounted re-attempt price in dollars (0/absent = full fee per attempt)
  kind?: "futures" | "cfd";        // market family, for the firm suggester
}

// What the journal knows about the series it handed the engine, and the
// Simulator cannot work out for itself.
//
// It lives on the shared singleton rather than being passed through `hooks`
// because it is STATE, not an event: the Validate tab reads it on every render
// to decide how wide its intervals should be. Null whenever the edge comes from
// the sliders, which is the honest answer there - a slider edge is iid by
// construction, has no dates, no accounts and no subsets anybody scanned.
export interface EdgeMeta {
  scope: string;             // "all accounts", or the account name
  // the same multiset in TRADE ORDER. `trades` keeps the journal's newest-first
  // order because every seeded estimator in the app draws by index from it;
  // autocorrelation, the block bootstrap and the day clustering need chronology,
  // so they read this instead. Null when the two cannot be lined up.
  ordered: number[] | null;
  days: number[] | null;     // day index per trade, parallel to `ordered`
  accounts: number;          // distinct accounts contributing to the series
  mirrored: number;          // near-duplicate trades detected across accounts
  cutName: string | null;    // the segment currently left OUT, if any
  looks: number;             // distinct subsets tested against this record
  fullRs: number[] | null;   // the whole record, so a cut can be shown beside its baseline
}

export interface EdgeState {
  p: number;          // win probability OF DECIDED trades (scratches sit outside it)
  b: number;          // payoff in R
  // share of ALL trades that scratch at 0R - neither win nor loss. The slider
  // model was pure two-outcome Bernoulli, which silently forced every logged
  // scratch into the loss column the moment someone matched sliders to a real
  // record; s makes the third outcome first-class. 0 = the old model exactly.
  s: number;
  payMode: "rr" | "pf";
  n: number;          // trades in record (CI sample size)
  trades: number[] | null; // journal R-multiples when "Use my journal" is on
  meta: EdgeMeta | null;   // what the journal knows about that series (null on sliders)
}

export const S: EdgeState = { p: 0.55, b: 1.0, s: 0, payMode: "rr", n: 120, trades: null, meta: null };

// preset account values are only the fallback for a fresh install; selecting a
// preset applies the RULES and keeps the user's account size (see sim.ts)
export const PRESETS: Record<string, Firm> = {
  "2step":  { name: "2-step",           type: "2step",  account: 100000, p1: 10, p2: 5, maxdd: 10, ddType: "static",   ddLock: 1, daily: 5, minDays: 0, cons: 0, tpd: 5, split: 90, fee: 540 },
  "1phase": { name: "1-phase",          type: "1phase", account: 100000, p1: 8,  p2: 0, maxdd: 8,  ddType: "static",   ddLock: 1, daily: 4, minDays: 0, cons: 0, tpd: 5, split: 90, fee: 400 },
  "futures":{ name: "Futures trailing", type: "futures",account: 50000,  p1: 6,  p2: 0, maxdd: 4,  ddType: "trailing", ddLock: 1, daily: 0, minDays: 5, cons: 0, tpd: 5, split: 90, fee: 150 },
};

// ---------------------------------------------------------------------------
// EVERY FIRM FIELD HAS A DOMAIN, AND IT IS ENFORCED HERE
// ---------------------------------------------------------------------------
//
// A user typed 10,000,000 into "Trades per day". tpd is a LOOP BOUND - every
// walk steps maxDays x tpd and every modelled year is 252 x tpd - so that asked
// phaseWalk for a five-billion-element array and killed the renderer with Out of
// Memory. The firm is persisted, so every subsequent launch reloaded the same
// value and died again: the app bricked itself, recoverable only by clearing
// storage by hand.
//
// The lesson is not "clamp tpd". It is that a `max` attribute on an input is a
// suggestion to a mouse, not a guarantee: it does not stop typing or pasting,
// and a firm reaches F from four routes that never touch a form - saved presets,
// restored sim state, imported backups and per-account bindings. So the domain
// lives at the MODEL boundary, in one table, on the one function every route
// passes through.
//
// Two classes of field here, and only the first can hang the app:
//   LOOP BOUNDS  - tpd (and timeLimit, already capped inside evalDays). These are
//                  correctness-critical: unbounded means non-terminating.
//   VALUE DOMAINS - money, percentages, day counts. An absurd value here produces
//                  an absurd READOUT, never a hang, but a $1e18 account and a
//                  4,000% profit split are not answers either.
// Bounds are generous on purpose: this must never refuse a real firm. The widest
// account in the catalogue is $100k and the widest fee $540.
const FIRM_BOUNDS: Record<string, [number, number]> = {
  account: [100, 100000000], p1: [0, 1000], p2: [0, 1000], maxdd: [0.01, 100],
  ddLock: [0, 1], daily: [0, 100], minDays: [0, 500], cons: [0, 100],
  tpd: [1, 20],                 // THE loop bound - see the note above
  split: [0, 100], fee: [0, 1000000], timeLimit: [0, 500], activation: [0, 1000000],
  payoutMin: [0, 10000000], payoutEvery: [0, 365], payoutFirst: [0, 365],
  payoutBuffer: [0, 10000000], payoutCap: [0, 100], payoutCapAmt: [0, 10000000],
  payoutCons: [0, 100], winDays: [0, 365], winAmt: [0, 10000000], resetFee: [0, 1000000],
};
// Integer fields, where a fractional value is not merely odd but changes the
// meaning of a loop or a counter.
const FIRM_INTS = new Set(["tpd", "minDays", "timeLimit", "payoutEvery", "payoutFirst", "winDays", "ddLock"]);
export function clampFirm<T extends Partial<Firm>>(f: T): T {
  const o = f as unknown as Record<string, unknown>;
  for (const k of Object.keys(FIRM_BOUNDS)) {
    if (o[k] == null) continue;
    const [lo, hi] = FIRM_BOUNDS[k];
    let v = Number(o[k]);
    // NaN and Infinity are not the same failure and must not get the same answer.
    // NaN carries no intent - there is nothing to preserve, so it falls to the
    // bottom of the domain. Infinity IS a number, just an out-of-range one, so it
    // clamps like any other: to the END IT CAME FROM. Collapsing it to `lo` would
    // silently DELETE a rule - a firm saved with an over-large winDays would come
    // back with winDays 0, i.e. no winning-days requirement at all, which is the
    // permissive direction and the one that flatters the firm.
    if (Number.isNaN(v)) v = lo;
    else if (!isFinite(v)) v = v > 0 ? hi : lo;
    if (FIRM_INTS.has(k)) v = Math.round(v);
    o[k] = Math.max(lo, Math.min(hi, v));
  }
  return f;
}

export const F: Firm = { ...PRESETS["2step"] };
export function setFirm(src: Firm) {
  // COPY FIRST. Callers pass F itself here more often than it looks - firmFor()
  // hands back the live singleton for every unbound journal scope, and
  // withFirm(F, ...) is then a self-alias. Clearing before reading from src
  // would wipe the very fields we are about to copy (feeMode, activation,
  // payout gates), which silently re-priced every unbound account's fees as a
  // bare one-time fee. The snapshot makes self-assignment a clean no-op.
  const from: Firm = clampFirm({ ...src });
  // a Firm written before 2.2 has no timeLimit/feeMode/activation key at all, and
  // Object.assign would leave the PREVIOUS firm's values in place. Clear them first
  // so selecting an unlimited-time firm after a 30-day one really does clear the limit.
  F.timeLimit = 0; F.feeMode = "once"; F.activation = 0; F.instant = false;
  F.payoutMin = 0; F.payoutEvery = 0; F.payoutFirst = 0; F.resetFee = 0;
  F.payoutBuffer = 0; F.payoutCap = 0; F.payoutCapAmt = 0; F.payoutCons = 0; F.winDays = 0; F.winAmt = 0;
  delete F.name; delete F.kind;
  // Catalogue-only metadata has to be scrubbed too: the suggester swaps dozens of
  // CatalogFirm records through this singleton, and without the deletes the FIRST
  // candidate's standing/note - and, because they are optional, a DIFFERENT
  // firm's disputed tag - stuck to F forever and leaked into saves, custom
  // presets and account bindings. Nothing renders them from F today; this keeps
  // it from becoming a lie the day something does. (`instant` is NOT scrubbed
  // any more - it moved onto the Firm shape proper, because a loaded instant
  // firm has to keep meaning "instant" on the Decision tab.)
  const meta = F as unknown as Record<string, unknown>;
  delete meta.standing; delete meta.confidence; delete meta.note; delete meta.disputed;
  Object.assign(F, from);
}

// The engine reads the F and S singletons directly, which is fine for the one
// firm on screen but wrong for the suggester, which has to score many firms
// against one edge. These swap in a candidate, run, and always put the originals
// back - including when fn throws, or a stray firm would leak into the whole UI.
export function withFirm<T>(f: Firm, fn: () => T): T {
  const saved: Firm = { ...F };
  try { setFirm(f); return fn(); }
  finally { setFirm(saved); }
}
export function withEdge<T>(trades: number[] | null, fn: () => T): T {
  const saved = S.trades;
  try { S.trades = trades; return fn(); }
  finally { S.trades = saved; }
}

// Human label for a drawdown mode; shared by the firm summary, the suggester
// table and the journal's suggestion card so all three read the same.
//
// It now names the LOCK too, because "trailing EOD DD $2,000" is an
// underspecified rule: whether the floor stops following you at the starting
// balance is the difference between a threshold that can only ever help you and
// one that ratchets forever, and most firms use the former. Nothing in the app
// printed it - ddLock had a control and no readout - so a trader comparing two
// firms on the card was comparing rules that were not fully written down.
// Static floors never move, so the qualifier is only meaningful on a trailing one.
export function ddLabel(f: { ddType: string; ddLock?: number }): string {
  if (f.ddType === "static") return "static";
  const base = f.ddType === "trailing-eod" ? "trailing EOD" : "trailing intraday";
  return base + (f.ddLock ? " (locks at start)" : " (never locks)");
}

// how a firm's payout GATES read in one phrase - empty when it has none. Shared
// by the Firms table and the journal card: a modelled input the user cannot see
// is half a lie, and these move real ranking dollars since 2.8.0.
export function gateLabel(f: { payoutBuffer?: number; payoutCap?: number; payoutCapAmt?: number; payoutCons?: number; winDays?: number; winAmt?: number }): string {
  const parts: string[] = [];
  if (f.payoutBuffer && f.payoutBuffer > 0) parts.push("$" + Math.round(f.payoutBuffer / 100) / 10 + "k buffer");
  if (f.payoutCap && f.payoutCap > 0) parts.push(f.payoutCap + "% cap");
  if (f.payoutCapAmt && f.payoutCapAmt > 0) parts.push("max $" + Math.round(f.payoutCapAmt).toLocaleString() + "/payout");
  if (f.payoutCons && f.payoutCons > 0) parts.push(f.payoutCons + "% max day");
  if (f.winDays && f.winDays > 0) parts.push(f.winDays + " win days" + (f.winAmt ? " $" + f.winAmt + "+" : ""));
  return parts.length ? "gates: " + parts.join(", ") : "";
}

// how a firm's payout cadence reads in one phrase. Shared by the suggester table
// and the journal card so both describe it the same way.
export function payLabel(f: { payoutEvery?: number; payoutFirst?: number }): string {
  const e = f.payoutEvery || 0;
  const base = e <= 0 ? "payout on demand"
    : e === 1 ? "daily payout"
      : e <= 5 ? "payout every " + e + "d"
        : "payout every " + e + "d (slow)";
  return base + (f.payoutFirst ? ", first after " + f.payoutFirst + "d" : "");
}

// PROP: prop-firm mode. Off, Edge Lab is a plain edge tool on your own account -
// Challenge / Funded / Decision, the rule guard and the prop odds are hidden.
export const view = { DISP: "$" as "$" | "%", PROP: true };

export function money(d: number): string {
  const s = d < 0 ? "-" : "";
  d = Math.abs(d);
  return s + "$" + Math.round(d).toLocaleString();
}
export function pct2d(p: number): number {
  return (p / 100) * F.account;
}
export function amt(p: number): string {
  return view.DISP === "$" ? money(pct2d(p)) : p.toFixed(1) + "%";
}
