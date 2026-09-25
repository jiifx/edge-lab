// The 1,000-trade sample journal: a modest, real edge with structure the Edge
// report and the Timing tab can find (setup quality, session, direction, the
// 4th trade of a day, tilt after two losses). Deterministic - the same seed
// gives the same trades - and the ONE source for both the in-app "Load sample
// journal" button and samples/sample-1000-trades.json (scripts/sample.mjs).
// Generated rather than embedded: the JSON is ~770 KB, this is a few KB.
// Seed 33 was picked so this record reads like the one the first public
// release shipped (46% decided win rate, +0.29R, PF 1.54) - any seed is the
// same model, they differ only in luck.
import { mulberry } from "./util";

export const SAMPLE_ACCT = "Sample 50k";
const RISK = 200;          // $ per 1R
const MU0 = 2.7;           // scales the edge
const FEE = 3.7;           // round-turn commissions per trade
const N = 1000;

// symbol: price level, stop points, size, tick
const INSTR: Record<string, [number, number, number, number]> = {
  MNQ: [21000, 20, 5, 0.25],
  MES: [5900, 8, 5, 0.25],
};
const SETUPS = ["Opening range break", "VWAP reclaim", "Trend pullback", "Failed breakout"];
const MODELS = ["Liq sweep + CHOCH", "Break and retest", "Session open drive", "Inside bar break"];
const CONDS = ["Trend day", "Range / chop", "High volatility", "Low volume", "News day", "Open drive", "Reversal"];
const QUALS = ["A+ setup", "B setup", "C setup", "Forced", "Revenge trade"];
const Q_MU: Record<string, number> = { "A+ setup": 1.35, "B setup": 1.05, "C setup": 0.85, "Forced": 0.62, "Revenge trade": 0.5 };
const S_MU: Record<string, number> = { "New York": 1.08, "London": 1.05, "Asia": 0.78 };
const SET_MU: Record<string, number> = { "Opening range break": 1.08, "VWAP reclaim": 1, "Trend pullback": 1.04, "Failed breakout": 0.9 };

const pad = (n: number) => String(n).padStart(2, "0");
// wall-clock "YYYY-MM-DDTHH:MM"; dates are handled as UTC so no DST or local
// timezone can shift a generated trade
const stamp = (ms: number) => { const d = new Date(ms); return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) + "T" + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()); };
const r2 = (x: number) => Math.round(x * 100) / 100;
const rtick = (x: number, tick: number) => r2(Math.round(x / tick) * tick);

// `endDay` (UTC ms of any time on the day) is where the record ends: the last
// trade lands in the week before it, so the calendar and "recent" views show a
// current record rather than one from the year the generator was written.
export function generateSample(endDay: number, seed = 33): { app: string; version: number; exportedAt: string; meta: unknown; trades: Record<string, unknown>[]; images: [] } {
  const rnd = mulberry(seed);
  const uni = (a: number, b: number) => a + (b - a) * rnd();
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const choices = <T>(a: T[], w: number[]) => {
    let x = rnd() * w.reduce((s, v) => s + v, 0);
    for (let i = 0; i < a.length; i++) { x -= w[i]; if (x < 0) return a[i]; }
    return a[a.length - 1];
  };
  const sampleK = <T>(a: T[], k: number) => {
    const c = a.slice(), out: T[] = [];
    for (let i = 0; i < k; i++) out.push(c.splice(Math.floor(rnd() * c.length), 1)[0]);
    return out;
  };

  const trades: Record<string, unknown>[] = [];
  const DAY = 86400000;
  let day = Date.UTC(2025, 4, 5);   // a Monday
  let n = 0;
  while (n < N) {
    const wd = (new Date(day).getUTCDay() + 6) % 7;   // Monday = 0
    if (wd < 5 && rnd() > 0.08) {
      const k = choices([1, 2, 3, 4], [0.22, 0.38, 0.28, 0.12]);
      const slots: [string, number][] = [];
      for (let i = 0; i < k; i++) {
        // a trader on New York time: London pre-market, the cash session, Asia evening
        const s = choices(["New York", "London", "Asia"], [0.62, 0.26, 0.12]);
        let h: number, m: number;
        if (s === "New York") { h = pick([9, 9, 10, 10, 11, 13, 14]); m = Math.floor(rnd() * 60); if (h === 9 && m < 30) m += 30; }
        else if (s === "London") { h = pick([3, 4, 5, 6]); m = Math.floor(rnd() * 60); }
        else { h = pick([19, 20, 21]); m = Math.floor(rnd() * 60); }
        slots.push([s, day + h * 3600000 + m * 60000]);
      }
      slots.sort((a, b) => a[1] - b[1]);
      let lossesToday = 0;
      for (let nth = 1; nth <= slots.length && n < N; nth++) {
        const [sess, t0] = slots[nth - 1];
        const sym = choices(["MNQ", "MES"], [0.65, 0.35]);
        const [px, stopPts, size, tick] = INSTR[sym];
        const long = rnd() < 0.58;
        const setup = pick(SETUPS), model = pick(MODELS);
        // tilt: after two losses, forced and revenge trades get likelier
        const quality = choices(QUALS, lossesToday < 2 ? [0.30, 0.38, 0.14, 0.12, 0.06] : [0.12, 0.30, 0.14, 0.26, 0.18]);
        const cond = sampleK(CONDS, pick([1, 1, 2]));
        const targetR = choices([2, 1.5, 3], [0.7, 0.2, 0.1]);

        // ---- the edge: mean of the favourable run before the stop, in R ----
        let mu = MU0 * Q_MU[quality] * S_MU[sess] * (long ? 1 : 0.88) * SET_MU[setup];
        if (cond.includes("Trend day")) mu *= 1.12;
        if (cond.includes("Range / chop")) mu *= 0.85;
        if (nth >= 4) mu *= 0.75;
        const run = -Math.log(1 - rnd()) * mu;            // how far it got before the stop
        const mistakes: string[] = [];
        if ((quality === "Forced" || quality === "Revenge trade") && rnd() < 0.5) mistakes.push(pick(["Chased", "Outside plan", "Overtraded"]));
        const scratch = rnd() < 0.05;
        const early = !scratch && run >= targetR && rnd() < 0.08;

        let R: number, mfe: number, mae: number, runR: number | null, note: string;
        if (scratch) {
          R = 0; mfe = r2(Math.min(run, 0.6)); mae = r2(uni(0.1, 0.6)); runR = null;
          note = "Stalled at entry, scratched it.";
        } else if (run >= targetR && !early) {
          R = targetR; mfe = targetR; mae = r2(uni(0, 0.85)); runR = r2(run);
          note = "Clean move, held to target.";
        } else if (early) {
          R = r2(uni(0.4, targetR * 0.8)); mistakes.push("Exited early");
          mfe = r2(R + uni(0.1, 0.6)); mae = r2(uni(0, 0.7)); runR = r2(run);
          note = "Took it off early; it went on to target.";
        } else {
          const slip = choices([0, -1, -2], [0.7, 0.25, 0.05]);
          const s = slip === 0 ? 0 : slip === -1 ? uni(0.02, 0.15) : uni(0.2, 0.45);
          if (s > 0.19) mistakes.push("Moved stop");
          R = -r2(1 + s); mfe = r2(run); mae = r2(1 + s); runR = null;
          note = "Failed and came back through the stop.";
        }
        if (R < 0) lossesToday++;

        // prices consistent with R
        const entry = rtick(px * (1 + uni(-0.04, 0.04)), tick);
        const sg = long ? 1 : -1;
        const stop = rtick(entry - sg * stopPts, tick);
        const target = rtick(entry + sg * stopPts * targetR, tick);
        const exit = rtick(entry + sg * stopPts * R, tick);
        const Rp = (exit - entry) / (entry - stop);
        const hold = R > 0 ? 25 + Math.floor(rnd() * 116) : 4 + Math.floor(rnd() * 42);
        const emoB = quality === "A+ setup" ? 1 : lossesToday < 2 ? pick([1, 2, 2, 3]) : pick([3, 4, 4, 5]);
        const emoA = Math.min(5, Math.max(1, emoB + (R < 0 ? 1 : R > 0 ? -1 : 0)));
        n++;
        trades.push({
          id: "s1k" + String(n).padStart(4, "0"),
          createdAt: t0, dateTime: t0, exitTime: t0 + hold * 60000,
          account: SAMPLE_ACCT, instrument: sym, direction: long ? "long" : "short",
          session: sess, setup, entryModel: model,
          entry, stop, target, exit, size,
          riskAmt: RISK, pnl: r2(Rp * RISK - FEE), fees: FEE,
          R: null, Rmanual: false, pnlManual: false,
          followedPlan: (quality === "A+ setup" || quality === "B setup") && !mistakes.length,
          planText: setup + " off " + model.toLowerCase() + ", stop beyond the structure, target " + targetR + "R.",
          notes: note,
          tags: { quality, mistake: Array.from(new Set(mistakes)).sort(), condition: cond },
          emotionBefore: emoB, emotionAfter: emoA,
          mfeR: mfe, maeR: mae, mfe: null, mae: null, mfeD: null, maeD: null,
          runR, rrR: null, imageIds: [],
        });
      }
    }
    day += DAY;
  }

  // slide the whole record by whole weeks so it ends just before endDay -
  // whole weeks keep every weekday and hour pattern intact
  const last = trades[trades.length - 1].dateTime as number;
  const end = Math.floor(endDay / DAY) * DAY;
  // the last trading day lands 1-7 days before endDay, never on or after it
  const shift = Math.ceil((Math.floor(last / DAY) * DAY - end + DAY) / (7 * DAY)) * 7 * DAY;
  for (const t of trades) {
    const d0 = (t.dateTime as number) - shift, e0 = (t.exitTime as number) - shift;
    t.dateTime = stamp(d0); t.exitTime = stamp(e0);
    // createdAt is a real instant; the wall-clock time read as UTC is close enough
    t.createdAt = d0;
  }
  return {
    app: "prop-edge-lab", version: 3, exportedAt: new Date(endDay).toISOString(),
    meta: {
      startBalance: null, accounts: [SAMPLE_ACCT], balances: { [SAMPLE_ACCT]: 50000 },
      accountFirms: {}, accountPhase: { [SAMPLE_ACCT]: { phase: "eval" } },
      rBasis: { [SAMPLE_ACCT]: { mode: "fixed", v: RISK } },
    },
    trades, images: [],
  };
}
