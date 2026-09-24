// Firm suggester: score every firm in the catalogue against one trader's edge and
// rank them. The engine reads the F/S singletons, so each candidate is scored
// inside withFirm/withEdge, which always restore the originals.
import { S, F, withFirm, withEdge } from "./state";
import { challengeStats, evalPass, fundedStats, costToFund, expectancy, payoutOdds, firstPayoutPct, PAID_SIMS, yearSteps } from "./engine";
import { CATALOG, CatalogFirm } from "./firms";
import { TAURI } from "./store";
export type { CatalogFirm };

export interface Ranked {
  firm: CatalogFirm;
  pass: number;        // probability of reaching a funded account (all phases)
  attempts: number;    // expected attempts to get there
  cost: number;        // expected dollars spent getting funded, fees + activation
  payout: number;      // expected first-year dollars after the split
  surv: number;        // probability the funded account is still alive after ~1yr
  ev: number;          // payout - cost. The ranking key.
  medDays: number;     // median trading days to pass, for the winners
  // --- the rest of the funnel: does any money actually come out? ---
  paidIfFunded: number; // chance a funded account reaches a FIRST payout inside the year
  paid: number;         // pass x paidIfFunded — one purchase turning into cash
  payDays: number;      // median trading days from funding to that first payout
  firstPay: number;     // dollars in one withdrawal, after the split
  evFirst: number;      // net dollars by the time of that first payout
}

// ONE sim size for every caller. There used to be a "fast" tier for the journal
// card and a "full" tier for the Firms table, and because the engine is
// deterministic (fixed seeds) that meant the same firm showed two different
// numbers on two screens — a real report from the field. Both callers now run
// identical work and therefore produce bit-identical figures. Both defer the
// work off the paint, so the cost is latency, never a frozen window.
// (Mirrored as SCORE_CHAL_SIMS/SCORE_FUND_SIMS in engine.rs — the native path
// must stay bit-identical or the desktop app and browser build disagree.)
const CHAL_SIMS = 1200;
const FUND_SIMS = 500;

// The raw simulation facts about one firm, before any money math. Both the TS
// engine and the Rust engine_score command produce exactly this shape, so the
// dollars are computed in ONE place (assemble below) no matter which engine ran.
interface RawScore {
  pass: number; meanDaysAll: number; medDays: number;
  profit: number; surv: number; paid: number; payDays: number;
}

// Money math on top of the raw sims — the single home for every dollar figure
// in the suggester, shared by the sync TS path and the async native path.
// h = the user's own counterparty haircut in [0,1): the share of promised
// payouts they assume never arrives. The model REFUSES to invent this number
// (the hazard-rate lesson), so it defaults to 0 and only the user moves it -
// and when they do, every affected surface says so. It discounts the payout
// side only, so it is provably monotone-down and the cost side stays honest.
function assemble(f: CatalogFirm, raw: RawScore, h: number): Ranked {
  return withFirm(f, () => {
    // An instant-funded firm has no evaluation: the fee buys the funded account
    // outright, so pass is certainty, the cost is deterministic, and payoutOdds
    // ALONE carries the journey to the first withdrawal. Scoring the stand-in
    // target as a pass gate AND the payout leg charged that journey twice — the
    // table called a $329 certainty a $614 gamble and halved the paid odds.
    const pass = f.instant ? 1 : raw.pass;
    const cf = costToFund(pass, f.instant ? 0 : raw.meanDaysAll);
    // fundedStats profit is percent-of-account R units, same as the Decision
    // tab: convert to dollars at THIS firm's account size, then split
    const payout = ((raw.profit / 100) * f.account * f.split) / 100 * (1 - h);
    // What one withdrawal is worth, and whether you are ahead by the time you
    // take it. This deliberately pairs paidIfFunded — the odds CONDITIONAL on
    // being funded — with cf.cost, which already prices re-attempting until
    // funded. Using the end-to-end `paid` here instead would charge for failing
    // the evaluation twice, once in the probability and again in the cost.
    const firstPay = ((firstPayoutPct() / 100) * f.account * f.split) / 100 * (1 - h);
    return {
      firm: f, pass, attempts: cf.attempts, cost: cf.cost, payout,
      surv: raw.surv, ev: payout - cf.cost, medDays: f.instant ? 0 : raw.medDays,
      paidIfFunded: raw.paid, paid: pass * raw.paid, payDays: raw.payDays,
      firstPay, evFirst: raw.paid * firstPay - cf.cost,
    };
  });
}

// The TS engine path. Callers must have the edge in place (withEdge).
function rawScoreTS(f: CatalogFirm, re: number, rf: number): RawScore {
  return withFirm(f, () => {
    // no evaluation to simulate on an instant firm — its pass leg is bought
    const st = f.instant ? null : challengeStats(re, CHAL_SIMS);
    const po = payoutOdds(rf, PAID_SIMS, yearSteps());
    const fs = fundedStats(rf, FUND_SIMS, yearSteps());
    return {
      pass: st ? evalPass(st, f) : 1,
      meanDaysAll: st ? st.meanDaysAll : 0,
      medDays: st ? st.medDays : 0,
      profit: fs.profit, surv: fs.surv, paid: po.p, payDays: po.medDays,
    };
  });
}

export function scoreFirm(f: CatalogFirm, re: number, rf: number, h = 0): Ranked {
  return assemble(f, rawScoreTS(f, re, rf), h);
}

// The async path: native Rust scoring in the Tauri app (bit-identical seeds and
// counts), TS fallback in the browser. One firm per call so callers can chunk
// the catalogue across macrotasks — scoring all 20 firms in one synchronous
// block froze the window for ~2s, and on a Mac's JavaScriptCore noticeably
// longer, which is exactly the reported "Firms tab lags".
// The slider edge is passed as an explicit snapshot (p, b), never read live:
// a chunked run outlives user input, and firm 12 scored against a freshly
// dragged win rate while firms 1-11 carry the old one would cache a mixed-edge
// table under the old key. The caller snapshots once; every firm sees it.
function withSlider<T>(p: number, b: number, sc: number, fn: () => T): T {
  const sp = S.p, sb = S.b, ss = S.s;
  try { S.p = p; S.b = b; S.s = sc; return fn(); } finally { S.p = sp; S.b = sb; S.s = ss; }
}

export function scoreFirmAsync(f: CatalogFirm, rs: number[] | null, p: number, b: number, sc: number, re: number, rf: number, h = 0): Promise<Ranked> {
  const tsPath = () => withSlider(p, b, sc, () => withEdge(rs, () => scoreFirm(f, re, rf, h)));
  if (TAURI) {
    return TAURI("engine_score", { rs: rs || [], p, b, s: sc, firm: f, instant: !!f.instant, re, rf })
      .then((o) => {
        const r = o as { pass: number; mean_days_all: number; med_days: number; profit_pct: number; surv: number; paid: number; pay_days: number };
        return withEdge(rs, () => assemble(f, {
          pass: r.pass, meanDaysAll: r.mean_days_all, medDays: r.med_days,
          profit: r.profit_pct, surv: r.surv, paid: r.paid, payDays: r.pay_days,
        }, h));
      })
      // a dead IPC bridge must degrade to the slower engine, not to no answer
      .catch(() => Promise.resolve(tsPath()));
  }
  return Promise.resolve(tsPath());
}

// best expected value first; a tie breaks toward the friendlier rules
export function rankOrder(a: Ranked, b: Ranked): number {
  return (b.ev - a.ev) || (b.pass - a.pass);
}

// Score a list of firms one per macrotask, so the main thread paints between
// firms instead of freezing for the whole catalogue. Returns a cancel function;
// a superseded run (slider moved, tab switched) must be cancelled or its stale
// rows would race the fresh ones into the cache.
export function scoreFirmsChunked(
  firms: CatalogFirm[], rs: number[] | null, re: number, rf: number, h: number,
  onProgress: (done: number, total: number) => void,
  onDone: (rows: Ranked[]) => void,
): () => void {
  let cancelled = false;
  const acc: Ranked[] = [];
  // the edge snapshot for the WHOLE run - see withSlider above
  const p = S.p, b = S.b, sc = S.s;
  const step = (i: number) => {
    if (cancelled) return;
    if (i >= firms.length) { onDone(acc); return; }
    scoreFirmAsync(firms[i], rs, p, b, sc, re, rf, h).then((r) => {
      if (cancelled) return;
      acc.push(r);
      onProgress(i + 1, firms.length);
      setTimeout(() => step(i + 1), 0);
    });
  };
  setTimeout(() => step(0), 0);
  return () => { cancelled = true; };
}

// rs = the trader's R multiples (journal), or null to use the slider edge.
// Synchronous, TS-engine-only: kept for tests and as the shape the chunked
// path reassembles; the UI paths go through scoreFirmsChunked.
export function rankFirms(kind: "futures" | "cfd", rs: number[] | null, re: number, rf: number): Ranked[] {
  return withEdge(rs, () =>
    CATALOG.filter((f) => f.kind === kind)
      .map((f) => scoreFirm(f, re, rf))
      .sort(rankOrder));
}

// The best firm in each family, from a single scoring pass. The journal shows
// both rather than one overall winner: whichever market you trade, the other
// family's leader is not a substitute, and hiding it behind a toggle would mean
// half the answer needs a click to find.
export function bestPerKind(rs: number[] | null, re: number, rf: number): { futures: Ranked | null; cfd: Ranked | null } {
  const all = withEdge(rs, () => CATALOG.map((f) => scoreFirm(f, re, rf)));
  return pickBestPerKind(all);
}
export function pickBestPerKind(all: Ranked[]): { futures: Ranked | null; cfd: Ranked | null } {
  const pick = (k: "futures" | "cfd") =>
    all.filter((r) => r.firm.kind === k).sort(rankOrder)[0] || null;
  return { futures: pick("futures"), cfd: pick("cfd") };
}

// Why this firm won - the rules that actually separated it from the runner-up,
// not a recital of its whole rule sheet. Comparing against the field is the only
// way this stays honest: a rule every firm shares explains nothing.
export function whyFirm(r: Ranked, rs: number[] | null, field?: Ranked[]): string {
  const f = r.firm;
  const mu = withEdge(rs, () => expectancy());
  if (mu <= 0) return "Negative edge: least-bad only.";
  const peers = (field || []).filter((x) => x.firm.name !== f.name).map((x) => x.firm);
  const rarer = (pred: (g: CatalogFirm) => boolean) => !peers.length || peers.filter(pred).length < peers.length / 2;
  const bits: string[] = [];
  if (f.instant) bits.push("instant funding");
  // headroom first: it moves the numbers more than anything else on this list
  const maxPeerDD = peers.reduce((m, g) => Math.max(m, g.maxdd), 0);
  if (peers.length && f.maxdd > maxPeerDD) bits.push("most drawdown room (" + f.maxdd + "%)");
  if (f.ddType === "static" && rarer((g) => g.ddType === "static")) bits.push("static drawdown");
  else if (f.ddType === "trailing-eod" && rarer((g) => g.ddType === "trailing-eod")) bits.push("end-of-day trailing");
  else if (f.ddType === "trailing") bits.push("wins despite intraday trailing");
  if (!f.timeLimit && rarer((g) => !g.timeLimit)) bits.push("no time limit");
  if (f.timeLimit) bits.push(f.timeLimit + "-day limit, low fee");
  if (f.feeMode === "once" && rarer((g) => g.feeMode === "once")) bits.push("one-time fee");
  if (!f.daily && rarer((g) => !g.daily)) bits.push("no daily loss limit");
  // when several firms carry the same modelled FUNDED terms the fee is most of
  // the decision, and saying so beats reciting a rule they all share. A payout
  // tie only certifies the funded side — the old wording claimed the firms were
  // "otherwise identical" while their PASS odds differed 1.8x on screen — so the
  // tie now also requires similar pass odds before it speaks.
  if (field && field.length > 1) {
    const ties = field.filter((x) => Math.abs(x.payout - r.payout) < 1 && Math.abs(x.pass - r.pass) < 0.05);
    if (ties.length > 1 && ties.every((x) => x.cost >= r.cost - 1)) {
      bits.push("cheapest of " + ties.length + " similar firms");
    }
  }
  if (!bits.length) bits.push("best pass-rate/cost balance");
  return bits.slice(0, 3).join(" · ");
}
