// Monte Carlo engine - a faithful port of the TS engine (same rules, same mulberry32 PRNG).
// The TS fallback runs in the browser; this native version powers the bootstrap odds instantly.
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Clone)]
pub struct Firm {
    #[serde(rename = "type")]
    pub type_: String,
    // read by first_payout_odds, which converts the dollar payout minimum into
    // the percent-of-account units the rest of the engine works in
    pub account: f64,
    pub p1: f64,
    pub p2: f64,
    pub maxdd: f64,
    #[serde(rename = "ddType")]
    pub dd_type: String,
    #[serde(rename = "ddLock")]
    pub dd_lock: i64,
    // absent in every firm written before 2.2, hence serde(default) -> 0 -> no limit
    #[serde(default, rename = "timeLimit")]
    pub time_limit: i64,
    // payout cadence; all default to 0 = withdraw on demand, which reproduces
    // the pre-2.2 behaviour exactly
    #[serde(default, rename = "payoutMin")]
    pub payout_min: f64,
    // Deliberately never read: spacing BETWEEN payouts moves neither the EV (wrong
    // sign, see funded_stats) nor the first-payout odds (nothing to space against).
    // Kept on the struct so the firm shape stays identical to the TS Firm and the
    // frontend's JSON deserialises without a special case.
    #[allow(dead_code)]
    #[serde(default, rename = "payoutEvery")]
    pub payout_every: i64,
    #[serde(default, rename = "payoutFirst")]
    pub payout_first: i64,
    // payout GATES (2.8.0) - hard mechanics of when money may leave, modelled in
    // BOTH funded_stats and first_payout_odds. All default 0 = off = streams
    // bit-identical to pre-gate builds. See the long note on fundedSim in
    // src/engine.ts for why gates are modelled while cadence stays out.
    #[serde(default, rename = "payoutBuffer")]
    pub payout_buffer: f64,
    #[serde(default, rename = "payoutCap")]
    pub payout_cap: f64,
    #[serde(default, rename = "payoutCapAmt")]
    pub payout_cap_amt: f64,
    #[serde(default, rename = "payoutCons")]
    pub payout_cons: f64,
    #[serde(default, rename = "winDays")]
    pub win_days: i64,
    #[serde(default, rename = "winAmt")]
    pub win_amt: f64,
    pub daily: f64,
    #[serde(rename = "minDays")]
    pub min_days: i64,
    pub cons: f64,
    pub tpd: i64,
    #[allow(dead_code)]
    pub split: f64,
    #[allow(dead_code)]
    pub fee: f64,
}

#[derive(Serialize)]
pub struct Odds {
    pub pass: f64,
    pub surv: f64,
    pub profit_pct: f64,
    // share of funded accounts that reach a FIRST withdrawal inside the year
    pub paid: f64,
    // mean trading days one evaluation attempt burns, washouts included - the
    // journal needs it to price monthly subscriptions the way costToFund does
    pub mean_days_all: f64,
    pub pass_lo: f64,
    pub pass_hi: f64,
    pub surv_lo: f64,
    pub surv_hi: f64,
}

// mulberry32, bit-identical to the JS version
pub struct Rng(u32);
impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng(seed)
    }
    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6D2B_79F5);
        let s = self.0;
        let mut t = (s ^ (s >> 15)).wrapping_mul(1 | s);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

// mirrors SWEEP_HABIT_DAYS in src/engine.ts
const SWEEP_HABIT_DAYS: i64 = 5;
// mirrors PAY_CHUNK in src/engine.ts - one withdrawal, in percent of account
const PAY_CHUNK: f64 = 5.0;
// Sim sizes and seeds mirrored from the TS side. These MUST track their TS
// twins - if either side changes, the parity anchors below have to be re-minted
// or the desktop app and the browser build show different numbers for the same
// firm. TS homes: yearSteps()/PAID_SIMS in src/engine.ts; the odds counts in
// computeOddsTS in src/journal.ts; CHAL_SIMS/FUND_SIMS in src/suggest.ts.
//
// A year is a fixed number of TRADING DAYS, not a fixed number of trades. The
// old flat 750 was 150 trading days at the documented 5 trades/day - 7.1 months
// by TRADING_DAYS_PER_MONTH = 21 - and its elapsed length moved with the firm's
// own trades-per-day setting, so "per year" meant a different span per firm.
// Mirrors yearSteps() in src/engine.ts; both sides must agree or the desktop
// app and the browser build show different numbers for the same journal.
const TRADING_DAYS_PER_YEAR: usize = 252;
fn year_steps(f: &Firm) -> usize {
    TRADING_DAYS_PER_YEAR * f.tpd.max(1) as usize
}
const PAID_SIMS: usize = 800;
const PAID_SEED: u32 = 7717;
const ODDS_CHAL_SIMS: usize = 2600;
const ODDS_FUND_SIMS: usize = 1200;
const BOOT_N: usize = 24;
const BOOT_SEED: u32 = 4242;
const BOOT_CHAL_SIMS: usize = 500;
const BOOT_FUND_SIMS: usize = 300;
const SCORE_CHAL_SIMS: usize = 1200;
const SCORE_FUND_SIMS: usize = 500;

fn sample_r(rs: &[f64], rnd: &mut Rng) -> f64 {
    rs[(rnd.next() * rs.len() as f64) as usize % rs.len()]
}

// The trader's edge: either a list of real R multiples to resample, or the
// slider model (win probability p paying b, else -1). Mirrors sampleR in
// src/engine.ts EXACTLY - both arms consume one PRNG draw, so a walk under
// either edge stays bit-identical to the TS engine's stream.
#[derive(Clone, Copy)]
pub enum Edge<'a> {
    Trades(&'a [f64]),
    // s = scratch share of ALL trades (0R, neither win nor loss); p = win rate
    // of DECIDED trades. One draw covers all three outcomes, and with s=0 the
    // comparison collapses to the old u < p exactly - identical streams. The
    // operation ORDER mirrors sampleR in src/engine.ts and must stay identical.
    Coin { p: f64, b: f64, s: f64 },
}
impl<'a> Edge<'a> {
    fn draw(&self, rnd: &mut Rng) -> f64 {
        match self {
            Edge::Trades(rs) => sample_r(rs, rnd),
            Edge::Coin { p, b, s } => {
                let u = rnd.next();
                if u < *s {
                    0.0
                } else if u < *s + (1.0 - *s) * *p {
                    *b
                } else {
                    -1.0
                }
            }
        }
    }
}

enum WalkResult {
    Pass,
    DdFail,
    DailyFail,
    Timeout,
}

// Mirrors ddFloor() in src/engine.ts exactly - "trailing" is intraday (trails the
// highest equity tick), "trailing-eod" trails only the end-of-day closed balance,
// anything else is a static floor from the starting balance.
fn dd_floor(f: &Firm, peak: f64, peak_eod: f64, dd: f64) -> f64 {
    if f.dd_type == "static" {
        return -dd;
    }
    let base = if f.dd_type == "trailing-eod" { peak_eod } else { peak };
    if f.dd_lock != 0 {
        (base - dd).min(0.0)
    } else {
        base - dd
    }
}
// Mirrors evalDays(): 0 / absent means no time limit, for which 500 days stands in.
fn eval_days(f: &Firm) -> i64 {
    if f.time_limit > 0 {
        f.time_limit.min(500)
    } else {
        500
    }
}

fn phase_walk(e: Edge, f: &Firm, target: f64, risk: f64, rnd: &mut Rng) -> (WalkResult, i64) {
    let tpd = f.tpd.max(1);
    let max_days: i64 = eval_days(f);
    let coast = risk.min(0.12);
    let (mut eq, mut peak, mut peak_eod, mut day_start) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let (mut day_idx, mut in_day) = (0i64, 0i64);
    let mut reached = false;
    let mut day_pnls: Vec<f64> = vec![0.0];
    for _t in 0..(max_days * tpd) {
        let use_risk = if reached { coast } else { risk };
        let step = e.draw(rnd) * use_risk;
        eq += step;
        day_pnls[day_idx as usize] += step;
        if eq > peak {
            peak = eq;
        }
        let floor = dd_floor(f, peak, peak_eod, f.maxdd);
        if eq <= floor {
            return (WalkResult::DdFail, day_idx + 1);
        }
        if f.daily > 0.0 && (eq - day_start) <= -f.daily {
            return (WalkResult::DailyFail, day_idx + 1);
        }
        if eq >= target {
            reached = true;
        }
        if eq >= target && (day_idx + 1) >= f.min_days {
            let max_day = day_pnls.iter().cloned().fold(f64::MIN, f64::max);
            let ok = f.cons <= 0.0 || (eq > 0.0 && max_day / eq <= f.cons / 100.0);
            if ok {
                return (WalkResult::Pass, day_idx + 1);
            }
        }
        in_day += 1;
        if in_day >= tpd {
            in_day = 0;
            if eq > peak_eod {
                peak_eod = eq;
            }
            day_idx += 1;
            day_start = eq;
            day_pnls.push(0.0);
        }
    }
    (WalkResult::Timeout, day_idx + 1)
}

// The evaluation, attempt by attempt. mean_days_all spans BOTH phases of a
// 2-step and includes washouts, because a monthly subscription bills for those
// days whether you pass or not; med_days is the winners' median, both phases -
// the exact mirror of challengeStats() in src/engine.ts, including the
// (len*0.5)|0 median indexing.
pub struct ChalOut {
    pub pass: f64,
    pub mean_days_all: f64,
    pub med_days: f64,
}
pub fn challenge_stats_e(e: Edge, f: &Firm, risk: f64, n: usize, seed: u32) -> ChalOut {
    let mut rnd = Rng::new(seed);
    let two_step = f.type_ == "2step" && f.p2 > 0.0;
    let mut both = 0usize;
    let mut sum_days = 0i64;
    let mut win_days: Vec<i64> = Vec::new();
    for _ in 0..n {
        let (r1, d1) = phase_walk(e, f, f.p1, risk, &mut rnd);
        sum_days += d1;
        if let WalkResult::Pass = r1 {
            if two_step {
                let (r2, d2) = phase_walk(e, f, f.p2, risk, &mut rnd);
                sum_days += d2;
                if let WalkResult::Pass = r2 {
                    both += 1;
                    win_days.push(d1 + d2);
                }
            } else {
                both += 1;
                win_days.push(d1);
            }
        }
    }
    win_days.sort_unstable();
    ChalOut {
        pass: both as f64 / n as f64,
        mean_days_all: sum_days as f64 / n as f64,
        med_days: if win_days.is_empty() { 0.0 } else { win_days[win_days.len() / 2] as f64 },
    }
}

pub fn challenge_pass(rs: &[f64], f: &Firm, risk: f64, n: usize, seed: u32) -> f64 {
    challenge_stats_e(Edge::Trades(rs), f, risk, n, seed).pass
}

pub fn funded_stats(rs: &[f64], f: &Firm, risk: f64, n: usize, t_steps: usize, seed: u32) -> (f64, f64) {
    funded_stats_e(Edge::Trades(rs), f, risk, n, t_steps, seed)
}
pub fn funded_stats_e(e: Edge, f: &Firm, risk: f64, n: usize, t_steps: usize, seed: u32) -> (f64, f64) {
    let mut rnd = Rng::new(seed);
    let tpd = f.tpd.max(1);
    // an unlocked trailing threshold of either flavour follows the account up
    // forever, so a withdrawal drags the threshold down with it
    let trail_unlocked = f.dd_type != "static" && f.dd_lock == 0;
    // Payout cadence is NOT scored HERE - see the long note on fundedSim in
    // src/engine.ts. Slower payouts measured as BETTER because unwithdrawn profit
    // doubles as drawdown cushion, and the real costs of a slow payout sit outside
    // this model. The fields still drive first_payout_odds below, where the sign
    // is provable rather than measured.
    let chunk = PAY_CHUNK;
    let every = SWEEP_HABIT_DAYS;
    // payout gates - mirrors fundedSim in src/engine.ts exactly. Branches on
    // existing state only, no draws; all fields 0 = the pre-gate path verbatim.
    let buf_pct = if f.account > 0.0 { f.payout_buffer / f.account * 100.0 } else { 0.0 };
    let cap_f = f.payout_cap.clamp(0.0, 100.0);
    let cap_amt_pct = if f.account > 0.0 { f.payout_cap_amt / f.account * 100.0 } else { 0.0 };
    let win_n = f.win_days.max(0);
    let win_pct = if f.account > 0.0 { f.win_amt / f.account * 100.0 } else { 0.0 };
    let min_pct = if f.account > 0.0 { f.payout_min / f.account * 100.0 } else { 0.0 };
    let cons_f = f.payout_cons.clamp(0.0, 100.0);
    let gated = buf_pct > 0.0 || cap_f > 0.0 || cap_amt_pct > 0.0 || win_n > 0 || cons_f > 0.0;
    let (mut sum_profit, mut alive_n) = (0.0f64, 0usize);
    for _ in 0..n {
        let (mut eq, mut peak, mut peak_eod, mut banked) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
        let (mut in_day, mut since_pay) = (0i64, 0i64);
        let mut day_start = 0.0f64;
        let mut alive = true;
        let mut win_count = 0i64;
        let (mut best_day, mut profit_since) = (0.0f64, 0.0f64);
        for _ in 0..t_steps {
            eq += e.draw(&mut rnd) * risk;
            if eq > peak {
                peak = eq;
            }
            // daily loss limit enforced funded-side since 2.4.0 - see the long
            // note on fundedSim in src/engine.ts. Checked before the rollover
            // resets day_start, mirroring phase_walk.
            if f.daily > 0.0 && eq - day_start <= -f.daily {
                alive = false;
                break;
            }
            in_day += 1;
            if in_day >= tpd {
                let day_pnl = eq - day_start;
                if win_n > 0 && day_pnl >= win_pct {
                    win_count += 1;
                }
                if cons_f > 0.0 {
                    if day_pnl > best_day { best_day = day_pnl; }
                    profit_since += day_pnl;
                }
                in_day = 0;
                since_pay += 1;
                if eq > peak_eod {
                    peak_eod = eq;
                }
                day_start = eq;
            }
            let fl = dd_floor(f, peak, peak_eod, f.maxdd);
            if eq <= fl {
                alive = false;
                break;
            }
            let cons_ok = cons_f <= 0.0 || profit_since <= 0.0 || best_day / profit_since <= cons_f / 100.0;
            if since_pay >= every && cons_ok && (win_n <= 0 || win_count >= win_n) && (buf_pct <= 0.0 || eq >= buf_pct) {
                // cap shrinks the habit chunk; a gated firm refuses anything
                // under its minimum. Ungated = the pre-gate arithmetic exactly.
                // habit chunk, %-of-profit cap and fixed $ ceiling - smallest wins
                let mut w = chunk;
                if cap_f > 0.0 { w = w.min(cap_f / 100.0 * eq); }
                if cap_amt_pct > 0.0 { w = w.min(cap_amt_pct); }
                let w_ok = w > 0.0 && (!gated || w >= min_pct);
                if w_ok && trail_unlocked {
                    if eq >= w {
                        banked += w;
                        eq -= w;
                        peak -= w;
                        // unclamped, mirroring fundedSim: distance to the floor
                        // must survive a withdrawal unchanged
                        peak_eod -= w;
                        // a withdrawal is not a trading loss
                        day_start -= w;
                        since_pay = 0;
                        win_count = 0;
                        best_day = 0.0;
                        profit_since = 0.0;
                    }
                } else if w_ok && eq >= fl + f.maxdd + w {
                    banked += w;
                    eq -= w;
                    day_start -= w;
                    since_pay = 0;
                    win_count = 0;
                    best_day = 0.0;
                    profit_since = 0.0;
                }
            }
        }
        // cash actually withdrawn only - whatever is left in the account is
        // collateral, not payout (see fundedSim in src/engine.ts)
        sum_profit += banked;
        if alive {
            alive_n += 1;
        }
    }
    (sum_profit / n as f64, alive_n as f64 / n as f64)
}

// Mirrors firstPayoutSim/payoutOdds in src/engine.ts - the odds that a funded
// account ever pays you ONCE, rather than how much it pays on average. Unlike
// funded_stats this DOES apply the firm's first-payout gate, and the direction is
// provable: until the first withdrawal the equity path is identical whatever the
// gate says, so a longer wait or a bigger minimum can only push the first
// qualifying moment later, and ruin is absorbing. Locked by
// `payout_gate_can_only_lower_the_odds` below. payout_every is a minimum SPACING
// between payouts and there is no earlier payout to space against, so it is inert
// for a first payout and deliberately not read.
//
// COMMON RANDOM NUMBERS, unlike every other stat in this file: each run gets its
// own seeded stream rather than drawing from one shared one, so two gate settings
// see the identical price paths and the difference between them is the gate
// alone. With a shared stream a run that ends one step earlier shifts every later
// run onto different draws, and the reshuffle swamps the effect - measured that
// way, a 20-day wait came out 1.6pp BETTER than no wait. See payoutOdds in
// src/engine.ts.
pub fn first_payout_odds(rs: &[f64], f: &Firm, risk: f64, n: usize, t_steps: usize, seed: u32) -> f64 {
    first_payout_odds_days_e(Edge::Trades(rs), f, risk, n, t_steps, seed).0
}
// Also reports the median trading days from funding to the first withdrawal,
// over the runs that got there - payoutOdds().medDays in src/engine.ts, same
// (len*0.5)|0 indexing so the two engines quote the same day.
pub fn first_payout_odds_days_e(e: Edge, f: &Firm, risk: f64, n: usize, t_steps: usize, seed: u32) -> (f64, f64) {
    let tpd = f.tpd.max(1);
    let trail_unlocked = f.dd_type != "static" && f.dd_lock == 0;
    let first_day = f.payout_first.max(SWEEP_HABIT_DAYS);
    // payout_min is dollars; the engine works in percent of account
    let min_pct = if f.account > 0.0 { f.payout_min / f.account * 100.0 } else { 0.0 };
    let need = PAY_CHUNK.max(min_pct);
    // the payout gates - mirrors firstPayoutSim in src/engine.ts. Provable sign:
    // each can only push the first qualifying moment later; ruin is absorbing.
    let buf_pct = if f.account > 0.0 { f.payout_buffer / f.account * 100.0 } else { 0.0 };
    let cap_f = f.payout_cap.clamp(0.0, 100.0);
    let cap_amt_pct = if f.account > 0.0 { f.payout_cap_amt / f.account * 100.0 } else { 0.0 };
    let win_n = f.win_days.max(0);
    let win_pct = if f.account > 0.0 { f.win_amt / f.account * 100.0 } else { 0.0 };
    let cons_f = f.payout_cons.clamp(0.0, 100.0);
    let mut paid = 0usize;
    let mut pay_days: Vec<i64> = Vec::new();
    for i in 0..n {
        let mut rnd = Rng::new(seed.wrapping_add((i as u32).wrapping_mul(0x9E37_79B1)));
        let (mut eq, mut peak, mut peak_eod) = (0.0f64, 0.0f64, 0.0f64);
        let (mut in_day, mut day) = (0i64, 0i64);
        let mut day_start = 0.0f64;
        let mut win_count = 0i64;
        let (mut best_day, mut profit_since) = (0.0f64, 0.0f64);
        for _ in 0..t_steps {
            eq += e.draw(&mut rnd) * risk;
            if eq > peak {
                peak = eq;
            }
            // daily loss limit, same placement as fundedSim/firstPayoutSim in TS
            if f.daily > 0.0 && eq - day_start <= -f.daily {
                break;
            }
            in_day += 1;
            if in_day >= tpd {
                let day_pnl = eq - day_start;
                if win_n > 0 && day_pnl >= win_pct {
                    win_count += 1;
                }
                if cons_f > 0.0 {
                    if day_pnl > best_day { best_day = day_pnl; }
                    profit_since += day_pnl;
                }
                in_day = 0;
                day += 1;
                if eq > peak_eod {
                    peak_eod = eq;
                }
                day_start = eq;
            }
            let fl = dd_floor(f, peak, peak_eod, f.maxdd);
            if eq <= fl {
                break;
            }
            let enough = if trail_unlocked { eq >= need } else { eq >= fl + f.maxdd + need };
            // a % cap delays; a FIXED $ ceiling only limits size, unless it
            // sits below the firm's own minimum (payout then impossible)
            let gates_ok = (win_n <= 0 || win_count >= win_n)
                && (buf_pct <= 0.0 || eq >= buf_pct)
                && (cap_f <= 0.0 || cap_f / 100.0 * eq >= need)
                && (cap_amt_pct <= 0.0 || cap_amt_pct >= min_pct)
                && (cons_f <= 0.0 || profit_since <= 0.0 || best_day / profit_since <= cons_f / 100.0);
            if day >= first_day && gates_ok && enough {
                paid += 1;
                pay_days.push(day);
                break;
            }
        }
    }
    pay_days.sort_unstable();
    let med = if pay_days.is_empty() { 0.0 } else { pay_days[pay_days.len() / 2] as f64 };
    (paid as f64 / n as f64, med)
}

pub fn odds(rs: &[f64], f: &Firm, re: f64, rf: f64) -> Odds {
    let chal = challenge_stats_e(Edge::Trades(rs), f, re, ODDS_CHAL_SIMS, 12345);
    let (profit_pct, surv) = funded_stats(rs, f, rf, ODDS_FUND_SIMS, year_steps(f), 9931);
    let paid = first_payout_odds(rs, f, rf, PAID_SIMS, year_steps(f), PAID_SEED);
    // bootstrap: resample the trade list, rerun the MC - the spread is the sampling uncertainty
    let b = BOOT_N;
    let mut passes = Vec::with_capacity(b);
    let mut survs = Vec::with_capacity(b);
    for bi in 0..b {
        let mut rnd = Rng::new(BOOT_SEED + bi as u32);
        let samp: Vec<f64> = (0..rs.len()).map(|_| sample_r(rs, &mut rnd)).collect();
        passes.push(challenge_pass(&samp, f, re, BOOT_CHAL_SIMS, 12345));
        survs.push(funded_stats(&samp, f, rf, BOOT_FUND_SIMS, year_steps(f), 9931).1);
    }
    passes.sort_by(|a, b| a.partial_cmp(b).unwrap());
    survs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    Odds {
        pass: chal.pass,
        surv,
        profit_pct,
        paid,
        mean_days_all: chal.mean_days_all,
        pass_lo: passes[1],
        pass_hi: passes[b - 2],
        surv_lo: survs[1],
        surv_hi: survs[b - 2],
    }
}

// ---- native catalogue scoring ----
//
// Raw simulation outputs for one firm against one edge, at EXACTLY the sim
// counts and seeds the TS suggester uses (CHAL_SIMS/FUND_SIMS/PAID_SIMS in
// src/suggest.ts + src/engine.ts), so the desktop app's Firms table is
// bit-identical to the browser build's. All the money math (cost, payout,
// EV) stays on the TS side in ONE place - this returns nothing but sim facts.
//
// Why it exists: scoring 20 firms in TS is ~2s of main-thread Monte Carlo,
// and on a Mac (WKWebView/JavaScriptCore) noticeably worse - the "Firms tab
// lags" report. Native scoring turns that into milliseconds.
#[derive(Serialize)]
pub struct Score {
    pub pass: f64,
    pub mean_days_all: f64,
    pub med_days: f64,
    pub profit_pct: f64,
    pub surv: f64,
    pub paid: f64,
    pub pay_days: f64,
}

pub fn score(e: Edge, f: &Firm, re: f64, rf: f64, instant: bool) -> Score {
    // an instant-funded firm has no evaluation to simulate; the TS side would
    // discard these numbers anyway, so skip the work rather than fake it
    let chal = if instant {
        ChalOut { pass: 1.0, mean_days_all: 0.0, med_days: 0.0 }
    } else {
        challenge_stats_e(e, f, re, SCORE_CHAL_SIMS, 12345)
    };
    let (profit_pct, surv) = funded_stats_e(e, f, rf, SCORE_FUND_SIMS, year_steps(f), 9931);
    let (paid, pay_days) = first_payout_odds_days_e(e, f, rf, PAID_SIMS, year_steps(f), PAID_SEED);
    Score {
        pass: chal.pass,
        mean_days_all: chal.mean_days_all,
        med_days: chal.med_days,
        profit_pct,
        surv,
        paid,
        pay_days,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn firm_1phase() -> Firm {
        Firm {
            type_: "1phase".into(), account: 100000.0, p1: 8.0, p2: 0.0, maxdd: 8.0,
            dd_type: "static".into(), dd_lock: 1, time_limit: 0, daily: 4.0, min_days: 0, cons: 0.0,
            tpd: 5, split: 90.0, fee: 400.0,
            payout_min: 0.0, payout_every: 0, payout_first: 0, payout_buffer: 0.0, payout_cap: 0.0, payout_cap_amt: 0.0, payout_cons: 0.0, win_days: 0, win_amt: 0.0,
        }
    }

    fn edge(wr: f64, rr: f64, n: usize) -> Vec<f64> {
        // deterministic empirical distribution with exact win rate
        let wins = (wr * n as f64).round() as usize;
        (0..n).map(|i| if i < wins { rr } else { -1.0 }).collect()
    }

    #[test]
    fn anchor_full_model_matches_js() {
        // session-validated anchor: 1-phase, 60%/1R, 1% risk, WITH 4% daily limit -> ~0.82
        let p = challenge_pass(&edge(0.60, 1.0, 100), &firm_1phase(), 1.0, 4000, 12345);
        assert!((p - 0.82).abs() < 0.05, "got {p}");
    }

    // futures-shaped firm used by the drawdown-mode anchors below
    fn firm_futures(dd_type: &str, dd_lock: i64, time_limit: i64) -> Firm {
        Firm {
            type_: "futures".into(), account: 50000.0, p1: 6.0, p2: 0.0, maxdd: 4.0,
            dd_type: dd_type.into(), dd_lock, time_limit, daily: 0.0, min_days: 0, cons: 0.0,
            tpd: 5, split: 90.0, fee: 150.0,
            payout_min: 0.0, payout_every: 0, payout_first: 0, payout_buffer: 0.0, payout_cap: 0.0, payout_cap_amt: 0.0, payout_cons: 0.0, win_days: 0, win_amt: 0.0,
        }
    }

    // Anchors minted from the TS engine (src/engine.ts, same seed and inputs) on
    // 2026-07-27. They lock the three drawdown regimes to JS parity AND to their
    // correct ordering: static is the easiest floor, end-of-day trailing is
    // meaningfully easier than intraday trailing because an intraday spike you
    // give back never ratchets the threshold.
    #[test]
    fn dd_modes_match_js_and_rank_correctly() {
        let rs = edge(0.60, 1.0, 100);
        let stat = challenge_pass(&rs, &firm_futures("static", 1, 0), 1.0, 4000, 12345);
        let intra = challenge_pass(&rs, &firm_futures("trailing", 1, 0), 1.0, 4000, 12345);
        let eod = challenge_pass(&rs, &firm_futures("trailing-eod", 1, 0), 1.0, 4000, 12345);
        assert!((stat - 0.8137).abs() < 0.01, "static {stat}");
        assert!((intra - 0.6410).abs() < 0.01, "trailing-intraday {intra}");
        assert!((eod - 0.7083).abs() < 0.01, "trailing-eod {eod}");
        assert!(stat > eod && eod > intra, "ordering broke: {stat} {eod} {intra}");
    }

    #[test]
    fn unlocked_trailing_is_harder_than_locked() {
        let rs = edge(0.60, 1.0, 100);
        let open = challenge_pass(&rs, &firm_futures("trailing", 0, 0), 1.0, 4000, 12345);
        let eod_open = challenge_pass(&rs, &firm_futures("trailing-eod", 0, 0), 1.0, 4000, 12345);
        assert!((open - 0.6210).abs() < 0.01, "trailing unlocked {open}");
        assert!((eod_open - 0.7017).abs() < 0.01, "trailing-eod unlocked {eod_open}");
    }

    #[test]
    fn time_limit_only_bites_when_short() {
        let rs = edge(0.60, 1.0, 100);
        let unlimited = challenge_pass(&rs, &firm_futures("trailing-eod", 1, 0), 1.0, 4000, 12345);
        let roomy = challenge_pass(&rs, &firm_futures("trailing-eod", 1, 30), 1.0, 4000, 12345);
        let tight = challenge_pass(&rs, &firm_futures("trailing-eod", 1, 10), 1.0, 4000, 12345);
        assert!((unlimited - roomy).abs() < 0.005, "30 days should not bite: {unlimited} vs {roomy}");
        assert!(tight < unlimited, "10 days should bite: {tight} vs {unlimited}");
    }

    #[test]
    fn barrier_only_matches_closed_form() {
        // no daily limit: two-barrier ruin, closed form = 96.2%
        let mut f = firm_1phase();
        f.daily = 0.0;
        let p = challenge_pass(&edge(0.60, 1.0, 100), &f, 1.0, 4000, 12345);
        assert!((p - 0.962).abs() < 0.03, "got {p}");
    }

    #[test]
    fn negative_edge_rarely_passes() {
        let p = challenge_pass(&edge(0.40, 1.0, 100), &firm_1phase(), 1.0, 2000, 12345);
        assert!(p < 0.15, "got {p}");
    }

    // Payout cadence must be completely INERT in the score, and this asserts it
    // stays that way. It is not an oversight — it was wired in, measured, and
    // taken back out, because every formulation scored it with the wrong sign:
    //
    //   fixed-slice withdrawal, weekly sweep habit:
    //     every=5 -> 51.07   every=7 -> 53.26   every=10 -> 50.75   every=21 -> 29.27
    //     (humped: a 7-day window beat a 5-day one by 4%)
    //   full-excess withdrawal:
    //     every=5 -> 51.32   every=10 -> 52.78   every=21 -> 54.84   every=30 -> 57.80
    //     (monotonically increasing — slower is strictly "better")
    //   first-payout delay, either formulation: monotonically better out to 60 days
    //
    // The cause is structural: unwithdrawn profit is exposed to the floor, but it
    // is also a cushion against the floor, and the cushion wins. What actually
    // makes a slow payout bad — counterparty exposure, rule changes, accounts
    // closed from under you, liquidity — is outside this model, and inventing a
    // hazard rate for it would be fabricating the answer. A real cost left out is
    // honest; a real cost scored backwards is not.
    #[test]
    fn payout_cadence_is_inert_in_the_score() {
        let rs = edge(0.60, 1.0, 100);
        let cadence = |every: i64, first: i64, min: f64| {
            let mut f = firm_futures("trailing-eod", 1, 0);
            f.payout_every = every;
            f.payout_first = first;
            f.payout_min = min;
            funded_stats(&rs, &f, 0.5, 800, 750, 9931).0
        };
        let base = cadence(0, 0, 0.0);
        assert!(base > 0.0, "baseline should pay something: {base}");
        for (every, first, min) in [
            (5i64, 0i64, 0.0f64), (10, 0, 0.0), (21, 0, 0.0), (30, 0, 0.0),
            (0, 5, 0.0), (0, 15, 0.0), (0, 60, 0.0),
            (0, 0, 250.0), (0, 0, 2500.0), (0, 0, 5000.0),
            (21, 15, 2000.0),
        ] {
            let v = cadence(every, first, min);
            assert!((v - base).abs() < 1e-9,
                "cadence must not move the score: every={every} first={first} min={min} gave {v} vs {base}");
        }
    }

    // The mirror image of the test above, and the reason both can hold at once.
    // Cadence stays INERT in the EV because its sign there is wrong. The
    // FIRST-payout gate must MOVE the payout odds, and only ever downward. That
    // direction is not a measurement that could come back the other way, it is
    // structural: until the first withdrawal the equity path does not depend on
    // the gate at all, so a longer wait or a bigger minimum can only push the
    // first qualifying moment later, and ruin is absorbing. If a change ever makes
    // a slower gate score BETTER here, the change is wrong, not this test.
    #[test]
    fn payout_gate_can_only_lower_the_odds() {
        // a marginal 52% edge at 1% risk, where the account can genuinely die
        // before it ever pays. On a strong edge every gate is nearly free (a
        // 60%/1R trader at 0.5% loses 0.1pp to an 80-day wait), so testing there
        // would assert almost nothing.
        let rs = edge(0.52, 1.0, 100);
        let gate = |first: i64, min: f64| {
            let mut f = firm_futures("trailing-eod", 1, 0);
            f.payout_first = first;
            f.payout_min = min;
            first_payout_odds(&rs, &f, 1.0, 1500, 750, 7717)
        };
        let base = gate(0, 0.0);
        assert!((base - 0.3080).abs() < 0.005, "baseline drifted from JS: {base}");
        // inside the trader's own weekly sweep habit the gate cannot bite at all
        assert!((gate(5, 0.0) - base).abs() < 1e-9, "a 5-day gate is the habit already");
        let mut prev = base;
        for first in [10i64, 20, 40, 80] {
            let v = gate(first, 0.0);
            assert!(v <= prev + 1e-9, "a longer wait must never score better: first={first} gave {v} vs {prev}");
            prev = v;
        }
        assert!(prev < base * 0.7, "an 80-day wait should bite hard: {prev} vs {base}");
        // the minimum withdrawal is the same story. $2,500 is exactly the 5% chunk
        // the trader sweeps anyway, so it must be free; above that it has to bite.
        assert!((gate(0, 2500.0) - base).abs() < 1e-9, "a minimum below the sweep size is free");
        let mut prev_min = base;
        for min in [5000.0f64, 10000.0, 20000.0] {
            let v = gate(0, min);
            assert!(v <= prev_min + 1e-9, "a bigger minimum must never score better: min={min} gave {v} vs {prev_min}");
            prev_min = v;
        }
        assert!(prev_min < base * 0.7, "a $20k minimum on a $50k account should bite hard: {prev_min}");
        // payout_every is spacing BETWEEN payouts, and a first payout has no
        // earlier one to space against, so it must not touch this number
        let mut f = firm_futures("trailing-eod", 1, 0);
        f.payout_every = 30;
        let spaced = first_payout_odds(&rs, &f, 1.0, 1500, 750, 7717);
        assert!((spaced - base).abs() < 1e-9, "ongoing cadence must not move the FIRST payout: {spaced} vs {base}");
    }

    // The 2.8.0 payout GATES ride the same structural argument: a balance
    // buffer, a profit cap or a winning-days rule can only push the first
    // qualifying moment later, and ruin is absorbing. Zeroed gates must be
    // byte-identical to no gates - that half is already pinned by every anchor
    // above; this pins the direction and that each gate actually bites.
    #[test]
    fn payout_gates_only_delay_the_first_payout() {
        let rs = edge(0.52, 1.0, 100);
        let gate = |buf: f64, cap: f64, wd: i64, wa: f64| {
            let mut f = firm_futures("trailing-eod", 1, 0);
            f.payout_buffer = buf;
            f.payout_cap = cap;
            f.win_days = wd;
            f.win_amt = wa;
            first_payout_odds(&rs, &f, 1.0, 1500, 750, 7717)
        };
        let base = gate(0.0, 0.0, 0, 0.0);
        // buffer: monotone down, and a big one bites
        let mut prev = base;
        for buf in [1000.0f64, 3000.0, 6000.0, 12000.0] {
            let v = gate(buf, 0.0, 0, 0.0);
            assert!(v <= prev + 1e-9, "a bigger buffer must never score better: {buf} gave {v} vs {prev}");
            prev = v;
        }
        assert!(prev < base, "a 24%-of-account buffer must bite: {prev} vs {base}");
        // cap: withdrawing at most cap% of profit needs profit >= need/cap
        let mut prev_cap = base;
        for cap in [80.0f64, 50.0, 25.0] {
            let v = gate(0.0, cap, 0, 0.0);
            assert!(v <= prev_cap + 1e-9, "a tighter cap must never score better: {cap} gave {v} vs {prev_cap}");
            prev_cap = v;
        }
        assert!(prev_cap < base, "a 25% cap must bite: {prev_cap} vs {base}");
        // winning days: more required days can only delay
        let mut prev_w = base;
        for wd in [3i64, 5, 10] {
            let v = gate(0.0, 0.0, wd, 150.0);
            assert!(v <= prev_w + 1e-9, "more winning days must never score better: {wd} gave {v} vs {prev_w}");
            prev_w = v;
        }
        assert!(prev_w < base, "10 winning days of $150 must bite: {prev_w} vs {base}");
        // The funded cash-flow: NO direction asserted, and that is a finding.
        // The TS twin of this test measured a binding cap banking MORE (72.5
        // vs 70): a capped trader sweeps whatever is allowed each window while
        // the uncapped habit idles until a full chunk is affordable. Only the
        // first-payout sign is provable. This pins that the cap really moves
        // the cash-flow at a binding size (0.1% risk), mirroring the TS test.
        let all_win = edge(1.0, 1.0, 10);
        let f0 = firm_futures("static", 1, 0);
        let (bank0, _) = funded_stats(&all_win, &f0, 0.1, 200, 750, 9931);
        let mut fc = firm_futures("static", 1, 0);
        fc.payout_cap = 50.0;
        let (bank50, _) = funded_stats(&all_win, &fc, 0.1, 200, 750, 9931);
        assert!((bank50 - bank0).abs() > 1e-9, "a binding cap must move the cash-flow: {bank50} vs {bank0}");
        assert!(bank50 > 0.0, "and it must still pay something");
        // parity anchor minted from the TS engine on this exact scenario
        assert!((bank0 - 70.0).abs() < 1e-6, "ungated all-win anchor drifted from JS: {bank0}");
        assert!((bank50 - 72.5).abs() < 1e-6, "capped all-win anchor drifted from JS: {bank50}");
    }

    // The consistency PAYOUT gate (2.9.2) - 9 of 23 catalogued firms run one.
    // Same structural argument as the other gates on the first-payout leg: a
    // big day blocks the request until later profit dilutes its share, which
    // can only push the qualifying moment later.
    #[test]
    fn consistency_payout_gate_only_delays() {
        let rs = edge(0.52, 1.0, 100);
        let odds = |cons: f64| {
            let mut f = firm_futures("trailing-eod", 1, 0);
            f.payout_cons = cons;
            first_payout_odds(&rs, &f, 1.0, 1500, 750, 7717)
        };
        let base = odds(0.0);
        assert!((odds(100.0) - base).abs() < 1e-9, "100% can never bind - one day cannot exceed the whole");
        let mut prev = base;
        for c in [60.0f64, 40.0, 25.0, 15.0] {
            let v = odds(c);
            assert!(v <= prev + 1e-9, "a tighter consistency rule scored better at {c}: {v} vs {prev}");
            prev = v;
        }
        assert!(prev < base, "a 15% rule must bite: {prev} vs {base}");
    }

    // Anchors minted from the TS engine (src/engine.ts payoutOdds, same seeds and
    // inputs) on 2026-07-27, so the hand-ported Rust copy cannot drift away from
    // the one the browser build runs.
    #[test]
    fn first_payout_matches_js() {
        let rs = edge(0.60, 1.0, 100);
        let eod = first_payout_odds(&rs, &firm_futures("trailing-eod", 1, 0), 0.5, 800, 750, 7717);
        let intra = first_payout_odds(&rs, &firm_futures("trailing", 1, 0), 0.5, 800, 750, 7717);
        let stat = first_payout_odds(&rs, &firm_futures("static", 1, 0), 0.5, 800, 750, 7717);
        assert!((eod - 0.9038).abs() < 0.005, "trailing-eod {eod}");
        assert!((intra - 0.8850).abs() < 0.005, "trailing-intraday {intra}");
        assert!((stat - 0.9712).abs() < 0.005, "static {stat}");
        // same ordering as the pass odds: an intraday floor is the harshest
        assert!(stat > eod && eod > intra, "ordering broke: {stat} {eod} {intra}");
    }

    // The daily loss limit is enforced funded-side since 2.4.0 (it always was in
    // the eval), and like every other absorbing barrier its direction is
    // provable, not measured: an extra way to die can only remove paths, so a
    // tighter daily limit can never raise funded profit, survival, or the
    // first-payout odds. And a limit no single day can reach - tpd * risk
    // percent - must be EXACTLY as good as no limit at all, which also pins
    // down that pre-2.2 saves (daily absent -> 0) are untouched.
    #[test]
    fn daily_limit_can_only_lower_funded_results() {
        let rs = edge(0.55, 1.0, 100);
        let run = |daily: f64| {
            let mut f = firm_futures("trailing-eod", 1, 0);
            f.daily = daily;
            let (profit, surv) = funded_stats(&rs, &f, 1.0, 800, 750, 9931);
            let paid = first_payout_odds(&rs, &f, 1.0, 800, 750, 7717);
            (profit, surv, paid)
        };
        let base = run(0.0);
        // 5 trades x 1% risk = at most -5% in a day: a 6% limit is unreachable
        let unreachable = run(6.0);
        assert!((unreachable.0 - base.0).abs() < 1e-12, "unreachable daily must be inert: {} vs {}", unreachable.0, base.0);
        assert!((unreachable.1 - base.1).abs() < 1e-12);
        assert!((unreachable.2 - base.2).abs() < 1e-12);
        let mut prev = unreachable;
        for daily in [5.0f64, 4.0, 3.0, 2.0, 1.0] {
            let v = run(daily);
            assert!(v.0 <= prev.0 + 1e-9, "tighter daily raised profit: {daily} gave {} vs {}", v.0, prev.0);
            assert!(v.1 <= prev.1 + 1e-9, "tighter daily raised survival: {daily} gave {} vs {}", v.1, prev.1);
            assert!(v.2 <= prev.2 + 1e-9, "tighter daily raised paid odds: {daily} gave {} vs {}", v.2, prev.2);
            prev = v;
        }
        assert!(prev.0 < base.0 * 0.7, "a 1% daily at 1% risk should bite hard: {} vs {}", prev.0, base.0);
    }

    // Anchors minted from the TS engine on 2026-07-28, AFTER the funded-side
    // daily limit landed there - they pin the hand-mirrored Rust walks to the
    // exact TS numbers for a daily>0 firm and for the suggester's score()
    // inputs, so the desktop app cannot drift from the browser build.
    #[test]
    fn daily_and_score_match_js() {
        let rs = edge(0.55, 1.0, 100);
        let mut f = firm_futures("trailing-eod", 1, 0);
        f.daily = 2.0;
        let (profit, surv) = funded_stats(&rs, &f, 1.0, 800, 750, 9931);
        let paid = first_payout_odds(&rs, &f, 1.0, 800, 750, 7717);
        assert!((profit - 0.4688).abs() < 0.005, "daily2 profit {profit}");
        assert!(surv < 0.0001, "daily2 surv {surv}");
        assert!((paid - 0.1050).abs() < 0.005, "daily2 paid {paid}");
        // Topstep-shaped firm through score() at the suggester's counts
        let ts = Firm {
            type_: "futures".into(), account: 50000.0, p1: 6.0, p2: 0.0, maxdd: 4.0,
            dd_type: "trailing-eod".into(), dd_lock: 1, time_limit: 0, daily: 2.0,
            min_days: 2, cons: 50.0, tpd: 5, split: 90.0, fee: 49.0,
            payout_min: 0.0, payout_every: 5, payout_first: 5, payout_buffer: 0.0, payout_cap: 0.0, payout_cap_amt: 0.0, payout_cons: 0.0, win_days: 0, win_amt: 0.0,
        };
        let sc = score(Edge::Trades(&rs), &ts, 0.75, 0.5, false);
        assert!((sc.pass - 0.3350).abs() < 0.005, "score pass {}", sc.pass);
        assert!((sc.mean_days_all - 6.5317).abs() < 0.05, "score meanDays {}", sc.mean_days_all);
        assert!((sc.med_days - 7.0).abs() < 0.5, "score medDays {}", sc.med_days);
        assert!((sc.profit_pct - 3.6800).abs() < 0.05, "score profit {}", sc.profit_pct);
        assert!(sc.surv < 0.0001, "score surv {}", sc.surv);
        assert!((sc.paid - 0.3400).abs() < 0.005, "score paid {}", sc.paid);
        assert!((sc.pay_days - 16.0).abs() < 0.5, "score payDays {}", sc.pay_days);
        // a 2-step's mean-days spans BOTH phases, washouts included
        let two = Firm {
            type_: "2step".into(), account: 50000.0, p1: 10.0, p2: 5.0, maxdd: 10.0,
            dd_type: "static".into(), dd_lock: 0, time_limit: 0, daily: 5.0,
            min_days: 4, cons: 0.0, tpd: 5, split: 80.0, fee: 375.0,
            payout_min: 0.0, payout_every: 0, payout_first: 0, payout_buffer: 0.0, payout_cap: 0.0, payout_cap_amt: 0.0, payout_cons: 0.0, win_days: 0, win_amt: 0.0,
        };
        let ch = challenge_stats_e(Edge::Trades(&rs), &two, 0.75, 1200, 12345);
        assert!((ch.pass - 0.8967).abs() < 0.005, "2step both {}", ch.pass);
        assert!((ch.mean_days_all - 36.9292).abs() < 0.2, "2step meanDays {}", ch.mean_days_all);
        assert!((ch.med_days - 32.0).abs() < 0.5, "2step medDays {}", ch.med_days);
    }

    // The Coin edge (slider model) must consume exactly one draw per trade like
    // the Trades edge, or a native-scored slider table diverges from the TS
    // fallback. A p=1 coin always pays b, so a walk under it is deterministic.
    #[test]
    fn coin_edge_draw_parity() {
        let f = firm_futures("static", 1, 0);
        let sure = challenge_stats_e(Edge::Coin { p: 1.0, b: 1.0, s: 0.0 }, &f, 1.0, 50, 12345);
        assert!((sure.pass - 1.0).abs() < 1e-12, "a certain edge must always pass: {}", sure.pass);
        // 6% target at 1% risk of 1R wins = 6 trades = day 2 at 5/day
        assert!((sure.med_days - 2.0).abs() < 0.5, "med days {}", sure.med_days);
        let never = challenge_stats_e(Edge::Coin { p: 0.0, b: 1.0, s: 0.0 }, &f, 1.0, 50, 12345);
        // a coin that ONLY scratches can neither pass nor die - and it consumes
        // exactly one draw per trade like every other arm
        let flat = challenge_stats_e(Edge::Coin { p: 0.5, b: 1.0, s: 1.0 }, &f, 1.0, 20, 12345);
        assert!(flat.pass < 1e-12, "an all-scratch edge must never pass: {}", flat.pass);
        assert!(never.pass < 1e-12, "a hopeless edge must never pass: {}", never.pass);
    }

    // Scratch-edge parity, minted from the TS engine 2026-07-29: a Coin edge
    // with s=0.2 (60% of decided win 1R, one fifth of all trades scratch at 0R)
    // through the challenge, funded and paid walks. Pins the three-outcome arm
    // to the browser build the same way the Trades anchors pin resampling.
    #[test]
    fn scratch_coin_matches_js() {
        let e = Edge::Coin { p: 0.60, b: 1.0, s: 0.20 };
        let mut f = firm_futures("trailing-eod", 1, 0);
        f.daily = 2.0;
        let ch = challenge_stats_e(e, &f, 1.0, 1200, 12345);
        assert!((ch.pass - 0.3925).abs() < 0.005, "scr pass {}", ch.pass);
        assert!((ch.mean_days_all - 2.7575).abs() < 0.05, "scr meanDays {}", ch.mean_days_all);
        let (profit, surv) = funded_stats_e(e, &f, 0.5, 500, 750, 9931);
        assert!((profit - 14.4100).abs() < 0.05, "scr profit {profit}");
        assert!((surv - 0.0280).abs() < 0.005, "scr surv {surv}");
        let (paid, _) = first_payout_odds_days_e(e, &f, 0.5, 800, 750, 7717);
        assert!((paid - 0.6713).abs() < 0.005, "scr paid {paid}");
    }

    #[test]
    fn funded_survival_sane() {
        let (profit, surv) = funded_stats(&edge(0.60, 1.0, 100), &firm_1phase(), 0.5, 800, 750, 9931);
        assert!(surv > 0.9, "surv {surv}");
        assert!(profit > 0.0, "profit {profit}");
    }

    #[test]
    fn bootstrap_brackets_point() {
        let o = odds(&edge(0.55, 1.5, 60), &firm_1phase(), 0.75, 0.5);
        assert!(o.pass_lo <= o.pass && o.pass <= o.pass_hi.max(o.pass));
        assert!(o.pass_lo < o.pass_hi);
        assert!(o.surv_lo <= o.surv_hi);
    }
}
