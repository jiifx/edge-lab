// Firm catalogue.
//
// Every entry is a real, named firm's published rule set, translated into the
// same Firm shape the simulator uses so the engine can score them all against
// one edge. Percentages are of that firm's representative account size, which
// is the size quoted in `account`.
//
// INCLUSION BAR. This list is deliberately short. A firm is only here if it has
// a public payout record at scale, a multi-year (or very heavily reviewed)
// operating history, and rules published clearly enough to model. Small or
// short-lived firms are excluded even when their headline terms look generous,
// because a soft rule set is worthless if the payout is not there. `standing`
// records the evidence for each entry so the bar is auditable rather than
// a matter of taste. Firms cut for failing it are listed at the bottom.
//
// PROP FIRM RULES CHANGE OFTEN. Each record carries a confidence grade and, where
// sources disagreed, a `disputed` note; the UI surfaces both. This is a modelling
// aid, not an offer, an endorsement, an affiliate placement, or financial advice.
// Always read the firm's own current rules before paying for an evaluation.
//
// Modelling notes that apply throughout:
//  - `cons` is the share of TOTAL profit a single day may contribute. Some firms
//    instead cap the best day against the profit TARGET; those are marked in note.
//  - `split` uses the steady-state rate. Promotional or first-tranche splits
//    (e.g. 100% of a first $25k) are described in note rather than modelled, so
//    the ranking never flatters a firm on a rate most traders will not stay at.
//  - `tpd` is the trader's own trade frequency, not a firm rule; 5/day throughout
//    so every firm is compared on equal footing.
//  - EVERY firm is catalogued at its **$50,000** account (the one exception is
//    noted on the record). Both families were originally at their own headline
//    size - futures at $50k, CFD at $100k - which made the two lists' dollar
//    columns incomparable and inflated the CFD side purely on account size. Rules
//    are the same percentages at any size, so only the fee needed re-researching.
import type { Firm } from "./state";

export interface CatalogFirm extends Firm {
  name: string;
  kind: "futures" | "cfd";
  // the evidence that this firm clears the inclusion bar, shown in the UI
  standing: string;
  // how well the rules could be established from the firm's own current pages
  confidence: "high" | "medium" | "low";
  // anything the engine cannot model but the trader should know
  note?: string;
  // fields where sources disagreed and the value here is a judgement call
  disputed?: string;
  // Instantly funded: the fee buys the funded account outright - there is no
  // evaluation. The suggester scores pass=1, cost=fee, and lets the funded-side
  // first-payout sim alone carry the journey to a withdrawal. Without this flag
  // the stand-in target was scored as a pass gate AND the payout leg ran on top,
  // charging the same climb twice: the table called a deterministic $329 cost a
  // $614 gamble and halved the shown odds of ever being paid.
  instant?: true;
}

// The date the catalogue was last checked against the firms' rule pages.
export const CATALOG_ASOF = "2026-08-04";

// Elapsed days since that check. Both suggester surfaces read this ONE helper,
// so they can never disagree about how stale the rules are; the banner it feeds
// speaks only about time, never about whether the rules were right on the day -
// that remains each record's confidence/disputed tags.
export function catalogAgeDays(): number {
  const t = Date.parse(CATALOG_ASOF);
  return isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86400000)) : 0;
}

const TPD = 5;

export const CATALOG: CatalogFirm[] = [
  // ---------------- FUTURES ----------------
  {
    name: "Topstep", kind: "futures", type: "futures", account: 50000,
    p1: 6, p2: 0, maxdd: 4, ddType: "trailing-eod", ddLock: 1,
    daily: 2, minDays: 2, cons: 50, tpd: TPD, split: 90, fee: 49,
    feeMode: "monthly", activation: 149, timeLimit: 0, payoutMin: 125, payoutCons: 50, payoutEvery: 0, payoutFirst: 0, payoutCapAmt: 2000, winAmt: 150, winDays: 5,
    standing: "Operating since 2012 — the longest-running futures prop firm. Trustpilot 4.6 from 5,500+ reviews.",
    confidence: "high",
    disputed: "Per-request cap is the smaller of 50%-of-balance and a fixed $2,000 on the 50K XFA Standard path; only the fixed ceiling is modelled. A limited-time offer doubles the caps if a Daily Loss Limit was added at checkout - not modelled. VERIFIED 2026-08-04: there is no trading-day spacing or first-payout wait - the entire gate is the 5 winning days, so the day fields are 0. The earlier 5/5 was an inference, not a published rule.",
    note: "Trading Combine is a monthly subscription until you pass. Payout gates on the 50K XFA: 5 winning days of $150+ Net P&L per cycle (count restarts after each payout), $125 minimum, and a per-request ceiling of 50% of balance up to $2,000 (Consistency path $3,000). Caps lift on the Live Funded Account.",
  },
  {
    name: "Apex Trader Funding", kind: "futures", type: "futures", account: 50000,
    p1: 6, p2: 0, maxdd: 4, ddType: "trailing", ddLock: 1,
    daily: 0, minDays: 0, cons: 0, tpd: TPD, split: 100, fee: 79,
    feeMode: "once", activation: 79, timeLimit: 21, payoutMin: 500, payoutCons: 50, payoutEvery: 5, payoutFirst: 5, payoutCapAmt: 1500, winAmt: 200, winDays: 5, payoutBuffer: 2100,
    standing: "$439M+ paid to traders since 2022. Trustpilot 4.5 from 13,000+ reviews.",
    confidence: "high",
    disputed: "Payout caps are a per-payout-number ladder; the first tier ($1,500) is modelled. The 6-payout lifetime limit and the 50% consistency payout gate (no single day >=50% of profit since the last payout) are not modelled. Older 8-trading-day / $50-a-day rules are Legacy and no longer current.",
    note: "100% profit split. Payout gates: balance must clear the $2,100 safety net (and $52,600 to request), 5 qualifying days of $200+ each, $500 minimum, and fixed per-payout caps $1,500/$2,000/$2,500/$2,500/$3,000/$3,000 - after 6 approved payouts the account closes and a new evaluation must be bought. The one-time fee buys 30 calendar days (~21 trading days) of evaluation access with no extension.",
  },
  {
    name: "Tradeify Lightning", kind: "futures", type: "futures", account: 50000,
    p1: 6, p2: 0, maxdd: 4, ddType: "trailing-eod", ddLock: 1,
    daily: 2.5, minDays: 7, cons: 25, tpd: TPD, split: 90, fee: 492,
    feeMode: "once", activation: 0, timeLimit: 0, payoutMin: 1000, payoutCons: 20, payoutEvery: 5, payoutFirst: 0, payoutCapAmt: 2000, payoutBuffer: 3000,
    standing: "~$264M in tracked payouts across 119,000+ payouts (Payout Junction, Jun 2026) — the largest tracked payout volume of any firm here.",
    confidence: "medium",
    instant: true,
    note: "Instantly funded - the fee buys the account, there is no evaluation. Payout gates: a $3,000 profit goal before payout 1 (then $2,000 of FRESH profit per later cycle), $1,000 minimum, no trading-day count, and fixed caps of $2,000 (payouts 1-3) then $2,500 (4+). Progressive 20/25/30% consistency applies to each request.",
    disputed: "The payout-policy article (June 2026) states no day-count spacing and no minimum trading days, while the homepage Lightning card still shows 'Payout Frequency 5 Days'; the policy article is treated as authoritative. Only the FIRST cycle's $3,000 goal is modelled as a buffer - the recurring $2,000 fresh-profit goal per later payout is not. VERIFIED 2026-08-04: the 5-day payout frequency IS current (the homepage card was right and the policy article's silence is not a contradiction); first-payout wait remains 0. Fee corrected to the current $492 one-time for the 50K.",
  },
  {
    name: "Tradeify Growth", kind: "futures", type: "futures", account: 50000,
    p1: 6, p2: 0, maxdd: 4, ddType: "trailing-eod", ddLock: 1,
    daily: 2.5, minDays: 0, cons: 0, tpd: TPD, split: 90, fee: 145,
    feeMode: "once", activation: 0, timeLimit: 0, payoutMin: 500, payoutCons: 35, payoutEvery: 5, payoutFirst: 5, payoutCapAmt: 1500, resetFee: 95,
    // payout gates per an account holder's dashboard (Aug 2026): withdrawals
    // open once the balance holds a $3,000 buffer above start, take at most
    // 50% of profit, and need 5 winning days of $150+. If your dashboard says
    // otherwise, the firm editor fields override these.
    payoutBuffer: 3000, payoutCap: 0, winDays: 5, winAmt: 150,
    standing: "Same firm as Tradeify Lightning — ~$264M in tracked payouts (Payout Junction, Jun 2026).",
    confidence: "medium",
    note: "Tradeify 3.0 (April 2026) removed subscriptions - the evaluation is a one-time $145 purchase with $95 resets. Payout gates: balance must reach $53,000 (a $3,000 buffer), 5 of the trading days must each show more than $150 profit (count resets after each payout), $500 minimum, and fixed caps of $1,500/$2,000/$2,500/$3,000 by payout number. A 35% consistency rule applies to every funded payout request; the evaluation itself has none.",
    disputed: "The $3,000 buffer applies to accounts purchased after 12 Sep 2025; earlier accounts need $52,100. The per-payout ceiling is a fixed-dollar ladder, not a percentage - an earlier version of this catalogue modelled a 50%-of-profit cap that does not exist in the current policy. The 35% consistency gate is not modelled.",
  },  {
    name: "Tradeify Select (Flex)", kind: "futures", type: "futures", account: 50000,
    p1: 6, p2: 0, maxdd: 4, ddType: "trailing-eod", ddLock: 1,
    daily: 0, minDays: 3, cons: 40, tpd: TPD, split: 90, fee: 165,
    feeMode: "once", activation: 0, resetFee: 109, timeLimit: 0,
    payoutMin: 0, payoutEvery: 0, payoutFirst: 0, payoutCons: 0,
    payoutCap: 50, payoutCapAmt: 3000, winDays: 5, winAmt: 150,
    standing: "Tradeify is #1 all-time on the Payout Junction blockchain-verified leaderboard (~$303M across 119,000+ payouts, Aug 2026). Select is one of its three current account types.",
    confidence: "high",
    note: "One-phase evaluation with NO daily loss limit but a 40% consistency rule and 3 minimum days - the inverse of Growth, whose evaluation has a daily limit and no consistency rule. On passing you choose Flex or Daily payouts PERMANENTLY; this row is Flex. Its funded side has NO consistency gate at all (Growth's is 35%) and no balance buffer: 5 winning days of $150+, then up to 50% of total profit capped at a flat $3,000 from the first payout - double Growth's first-payout ceiling.",
    disputed: "SELECT DAILY is a genuinely different funded product ($2,100 buffer, $250 minimum, a $1,000 daily loss limit and a cycle-profit formula) and is NOT modelled here - it would need its own row. Every payout after the first also requires net-positive profit since the last one, a loss-recovery gate no field captures. The trailing floor locks at start + $100, not at start, so the lock is a $100 approximation. No official page states the evaluation has no time limit in so many words.",
  },

  {
    name: "MyFundedFutures (Rapid)", kind: "futures", type: "futures", account: 50000,
    p1: 6, p2: 0, maxdd: 4, ddType: "trailing-eod", ddLock: 1,
    daily: 0, minDays: 2, cons: 50, tpd: TPD, split: 90, fee: 157,
    feeMode: "monthly", activation: 0, timeLimit: 0, payoutMin: 500, payoutEvery: 1, payoutFirst: 1, payoutBuffer: 2100,
    standing: "~$197M in tracked payouts. Trustpilot 4.9 from 16,000+ reviews — the highest rating in the futures set.",
    confidence: "high",
    disputed: "The funded-stage drawdown regime differs from the evaluation's and is modelled at the evaluation's setting; ddLock approximates a lock at start + $100.",
    note: "Daily payouts from 24h after the first Sim Funded trade, $500 minimum - but only once $2,100 of realised profit is banked, which is the dominant gate. The funded stage switches to a $2,000 INTRADAY trailing drawdown (the evaluation trails end-of-day) that locks once it reaches start + $100.",
  },
  {
    name: "Alpha Futures (Zero)", kind: "futures", type: "futures", account: 50000,
    p1: 6, p2: 0, maxdd: 4, ddType: "trailing-eod", ddLock: 1,
    daily: 0, minDays: 0, cons: 0, tpd: TPD, split: 90, fee: 149,
    feeMode: "monthly", activation: 0, timeLimit: 0, payoutMin: 200, payoutCons: 40, payoutEvery: 5, payoutFirst: 5, payoutCapAmt: 1500, winAmt: 200, winDays: 5, payoutCap: 50,
    standing: "Trustpilot 4.9. End-of-day trailing on every plan and a 90% split from the first payout request.",
    confidence: "medium",
    note: "Payout gates: 5 WINNING days of $200+ accumulated between requests (plain trading days do not count, and the count resets per payout), at most 50% of account profit per request, a fixed $1,500 ceiling on the 50k Zero, a $200 minimum, and at most 4 payouts a month. A 40% consistency rule governs withdrawal eligibility on the Qualified account; the evaluation has none.",
    disputed: "Both caps apply - the 50% share and the fixed $1,500 - and both are modelled. The 4-payouts-a-month limit and the 40% consistency gate are not. Only LIVE-program accounts escape the caps.",
  },
  {
    name: "TakeProfit Trader", kind: "futures", type: "futures", account: 50000,
    p1: 6, p2: 0, maxdd: 4, ddType: "trailing-eod", ddLock: 1,
    daily: 0, minDays: 5, cons: 50, tpd: TPD, split: 80, fee: 170,
    feeMode: "monthly", activation: 130, timeLimit: 0, payoutMin: 0, payoutEvery: 1, payoutFirst: 0, payoutBuffer: 2000,
    standing: "Established futures firm with a consistent public payout record and clearly published rules.",
    confidence: "high",
    disputed: "Buffer-zone profit is withdrawable only by TERMINATING the account (50% back inside 60 trading days, 80% after) - not modelled. The funded PRO drawdown trails intraday while the Test trails end-of-day; modelled at the evaluation setting.",
    note: "Payouts from day one at an 80% split, but only once the account clears a $52,000 balance - the $2,000 buffer zone. Converting Test to PRO costs a one-time $130. Withdrawals of $250 or less carry a $50 fee, so ~$250 is the effective minimum.",
  },
  {
    name: "TradeDay (Quick Pay EOD)", kind: "futures", type: "futures", account: 50000,
    p1: 6, p2: 0, maxdd: 4, ddType: "trailing-eod", ddLock: 1,
    daily: 0, minDays: 5, cons: 30, tpd: TPD, split: 80, fee: 79,
    feeMode: "monthly", activation: 0, timeLimit: 0, payoutMin: 250, payoutEvery: 1, payoutFirst: 1,
    standing: "Long-standing UK-based futures firm, well regarded for rule clarity and payout reliability.",
    confidence: "high",
    disputed: "A single split field cannot express the 50/50-under-$4,000 tier, nor the mixed split when a payout straddles the line. Funded Live pays 90/10 after the Funded Sim stage.",
    note: "First payout after a single day of trading on the Funded Sim, next-business-day processing, $250 minimum. The split is TIERED per account: 50/50 while account profit is under $4,000, 80/20 above it - the catalogued 80% is the steady state only and overstates early payouts.",
  },
  {
    name: "Funded Futures Network", kind: "futures", type: "futures", account: 50000,
    p1: 6, p2: 0, maxdd: 4, ddType: "trailing-eod", ddLock: 1,
    daily: 0, minDays: 7, cons: 40, tpd: TPD, split: 80, fee: 199,
    feeMode: "monthly", activation: 120, timeLimit: 0, payoutMin: 500, payoutCons: 40, payoutEvery: 0, payoutFirst: 0, payoutCapAmt: 1500, payoutBuffer: 2500,
    standing: "Trustpilot 4.7 (94% five-star), noted for same-day payout processing.",
    confidence: "medium",
    note: "Same-day payouts whenever eligibility is met - no fixed spacing. Gates: the $2,000 drawdown buffer must be fully rebuilt PLUS $500 above it before any withdrawal, $500 minimum, fixed caps of $1,500 (payouts 1-3) then $2,000, and a 40% consistency rule. The STEADY product instead requires 5 fresh winning days per cycle.",
    disputed: "Catalogued as the Standard MAX subscription ($160/mo); the current STEADY product is a one-time $229 purchase with different payout gates. The 40% consistency rule - best day over profit since the last payout, where the profit tally resets each payout but the best day never does - is not modelled. A $10,000 global per-payout cap across all accounts is not modelled. NOTE: this is NOT Funded Futures Family, a separate Wyoming company with its own rules and its own row in this catalogue - the two are routinely confused.",
  },
  {
    name: "Earn2Trade (Trader Career Path)", kind: "futures", type: "futures", account: 25000,
    p1: 7, p2: 0, maxdd: 6, ddType: "trailing-eod", ddLock: 1,
    daily: 2.2, minDays: 0, cons: 30, tpd: TPD, split: 80, fee: 150,
    feeMode: "monthly", activation: 139, timeLimit: 0, payoutMin: 100, payoutEvery: 5, payoutFirst: 0, payoutCapAmt: 1750,
    standing: "Operating since 2019 with an established education-plus-funding track record.",
    confidence: "high",
    disputed: "The tiered split is by withdrawal SIZE, not accumulated profit, so an 80% assumption overstates small requests by 30 points. Withdrawal-method fees ($50 Rise non-US, 1.5% US) apply on top of the $100 net minimum. NOTE 2026-08-04: this record is the TCP25 ($25,000) model - the one firm not catalogued at $50,000 - so the $150/mo fee, the $1,500 split threshold and the $1,750 cap are the right figures for it. TCP50 ($50k) would be $190/mo, $2,250 and $3,000.",
    note: "Weekly Wednesday processing, $100 net minimum. The split is TIERED by the size of a single withdrawal on TCP25: 50% under $1,500, 80% at $1,500+ - the catalogued 80% assumes requests of $1,500 or more. LiveSim withdrawals are capped at $1,750 per request, and a $139 activation fee comes out of the first withdrawal.",
  },  {
    name: "Top One Futures", kind: "futures", type: "futures", account: 50000,
    p1: 6, p2: 0, maxdd: 4, ddType: "trailing-eod", ddLock: 1,
    daily: 2, minDays: 1, cons: 40, tpd: TPD, split: 90, fee: 39,
    feeMode: "once", activation: 189, resetFee: 35, timeLimit: 21,
    payoutMin: 500, payoutCons: 40, payoutEvery: 5, payoutFirst: 5, payoutBuffer: 2500, payoutCapAmt: 1500, winDays: 5, winAmt: 250,
    standing: "$24.9M in blockchain-verified payouts (Payout Junction all-time, Aug 2026) - #10 across all firms tracked - and its own site claims $27M+ over 228,000 accounts. Trustpilot 4.8 from 4,000+ reviews.",
    confidence: "high",
    note: "Launched April 2025 - the shortest history in this catalogue, which is the caveat against its top-tier tracked-payout standing. The $39 evaluation fee is cheap because the real cost is the $189 activation on passing. Payout gates: a $2,500 buffer, 5 winning days of $250+, $500 minimum and a fixed $1,500 ceiling per request.",
    disputed: "A 50% Daily Progression Rule applies from the second payout onward (half the requested amount must come from profit since the last payout) and a 40% consistency rule governs eligibility - neither is modelled. The evaluation fee buys 30 calendar days of access.",
  },
  {
    name: "Funded Futures Family", kind: "futures", type: "futures", account: 50000,
    p1: 6, p2: 0, maxdd: 4, ddType: "trailing-eod", ddLock: 1,
    daily: 0, minDays: 1, cons: 0, tpd: TPD, split: 90, fee: 179,
    feeMode: "monthly", activation: 0, resetFee: 203, timeLimit: 0,
    payoutMin: 0, payoutEvery: 3, payoutFirst: 3, payoutBuffer: 2100,
    payoutCapAmt: 2000, payoutCons: 40, winDays: 3, winAmt: 200,
    standing: "$23.7M in blockchain-verified payouts (Payout Junction all-time, Aug 2026); its own site shows a live counter above $22.6M. Operator is Funded Futures Family LLC, a Wyoming company.",
    confidence: "high",
    note: "A DIFFERENT company from Funded Futures Network - separate legal entities, separate help centres, different rules. Payout gates: a $2,100 buffer, 3 winning days of $200+, a 40% consistency rule on each request, and a fixed $2,000 ceiling per payout.",
    disputed: "The fee is the $179/month figure from the firm's own spec table; the $204 shown on the homepage is a struck-through pre-discount price. Modelled on the plan family the help centre documents most fully - FFF sells four (PRIME, PREMIER and others) and they do not share one rule set.",
  },


  // ---------------- CFD / FOREX ----------------
  {
    name: "FTMO", kind: "cfd", type: "2step", account: 50000,
    p1: 10, p2: 5, maxdd: 10, ddType: "static", ddLock: 0,
    daily: 5, minDays: 4, cons: 0, tpd: TPD, split: 80, fee: 375,
    feeMode: "once", activation: 0, timeLimit: 0, payoutMin: 20, payoutEvery: 0, payoutFirst: 10,
    standing: "The longest payout track record in CFD prop trading, operating since 2015 and widely treated as the category benchmark.",
    confidence: "high",
    disputed: "The catalogued fee is the EUR price (345 EUR) - FTMO's pricing table renders EUR by default and the USD figure could not be captured. The fee refund on first withdrawal is not representable in the once/monthly fee model, so the cost to fund reads pessimistic here.",
    note: "First payout 14 calendar days (10 trading days) after the first trade, then on demand. Minimum closed profit of $20 for bank wire, $50 for crypto. The one-time fee is REFUNDED with the first reward withdrawal on the 2-Step account.",
  },
  {
    name: "FundingPips (2-Step)", kind: "cfd", type: "2step", account: 50000,
    p1: 8, p2: 5, maxdd: 10, ddType: "static", ddLock: 0,
    daily: 5, minDays: 3, cons: 0, tpd: TPD, split: 85, fee: 289,
    feeMode: "once", activation: 0, timeLimit: 0, payoutMin: 500, payoutEvery: 10, payoutFirst: 10,
    standing: "~$261M in tracked payouts (Payout Junction, Jun 2026) — second only to Tradeify across all firms tracked.",
    confidence: "high",
    disputed: "Only the bi-weekly/80% cycle is modelled; the Monthly cycle's 100% split would rank this firm very differently. The daily loss baseline is the HIGHER of day-opening balance or equity and includes floating losses, so the dollar limit floats above $2,500 in profit.",
    note: "Reward cycle is chosen by the trader: the catalogued 14-day/80% cycle is one of four (Weekly 60%, Bi-weekly 80%, Monthly 100%, On-Demand 90% with a 35% consistency rule and a $1,000 minimum). Minimum reward is 1% of account size = $500. Cycle timing runs from the first executed trade and re-arms after each processed reward.",
  },
  {
    name: "FundedNext", kind: "cfd", type: "2step", account: 50000,
    p1: 8, p2: 5, maxdd: 10, ddType: "static", ddLock: 0,
    daily: 5, minDays: 5, cons: 40, tpd: TPD, split: 80, fee: 299.99,
    feeMode: "once", activation: 0, timeLimit: 0, payoutMin: 20, payoutEvery: 10, payoutFirst: 15,
    standing: "~$203M in tracked payouts (Payout Junction, Jun 2026), with a published 24-hour payout guarantee.",
    confidence: "high",
    disputed: "The 14-day cycle is CONDITIONAL - it applies only if you traded profitably and requested a withdrawal in the previous cycle, so skipping a payout does not simply roll the clock forward. Per-method withdrawal floors and ceilings override the $20 minimum. FundedNext also runs a separate futures arm not modelled here.",
    note: "Stellar 2-Step at $50,000. First payout 21 calendar days (15 trading days) after the first trade, then a 14-day cycle. $20 minimum, 80% split.",
  },
  {
    name: "The5ers", kind: "cfd", type: "2step", account: 50000,
    p1: 10, p2: 5, maxdd: 10, ddType: "static", ddLock: 0,
    daily: 5, minDays: 3, cons: 0, tpd: TPD, split: 80, fee: 278,
    feeMode: "once", activation: 0, timeLimit: 0, payoutMin: 150, payoutEvery: 10, payoutFirst: 10, payoutBuffer: 150,
    standing: "Operating since 2016 and consistently among the top firms by tracked payout volume.",
    confidence: "high",
    note: "Bootcamp/2-Step at $50,000, operating since 2016. Payouts every 14 calendar days (10 trading days); the $150 catalogued as a minimum is modelled as the profit threshold it actually is.",
    disputed: "A consistency rule gates every payout and scale-up - best day over total profit - but the percentage is NOT published per program (30%, 40% and 50% all appear across products), so it is not modelled. The old help.the5ers.com knowledge base is dead and its widely-cited withdrawal article no longer resolves; figures come from the current site.",
  },
  {
    name: "E8 Markets", kind: "cfd", type: "1phase", account: 50000,
    p1: 6, p2: 0, maxdd: 3, ddType: "trailing-eod", ddLock: 1,
    daily: 4, minDays: 0, cons: 0, tpd: TPD, split: 80, fee: 130,
    feeMode: "once", activation: 0, timeLimit: 0, payoutMin: 1000, payoutCons: 40, payoutEvery: 0, payoutFirst: 3,
    standing: "Long-established CFD firm with a documented payout history and a widely used rule set.",
    confidence: "medium",
    disputed: "The entry models a single-phase product; E8 no longer sells the 2-step it was originally catalogued from. The 40% Best Day payout gate is not modelled - a violating day does not fail the account, it just blocks payouts until further profit dilutes it below 40%.",
    note: "On-demand payouts, earliest 3 days into the performance stage. Universal $100 minimum, but each payout must also exceed 50% of the daily drawdown - over $1,000 on this configuration. Every request is governed by a 40% Best Day rule: no single day may exceed 40% of total profit at the moment of the request.",
  },
  {
    name: "City Traders Imperium", kind: "cfd", type: "2step", account: 50000,
    p1: 10, p2: 5, maxdd: 10, ddType: "static", ddLock: 0,
    daily: 5, minDays: 3, cons: 0, tpd: TPD, split: 80, fee: 365,
    feeMode: "once", activation: 0, timeLimit: 0, payoutMin: 100, payoutEvery: 21, payoutFirst: 7, winAmt: 0, winDays: 7, payoutBuffer: 1000,
    standing: "Operating since 2018, long-standing reputation for paying and for a stable rule set.",
    confidence: "high",
    disputed: "The 7 profitable days and the 2% buffer are stated as FIRST-payout requirements only and do not reset per payout, but the engine applies them per payout - so later payouts read pessimistic. No per-day dollar threshold defines a 'profitable' day. The monthly cadence is a calendar window, approximated as 21 trading days.",
    note: "Standard funded traders are paid MONTHLY, in the last 5 days of each calendar month - weekly cadence is a Bronze VIP perk and anytime is Silver. The first payout needs at least 7 profitable trading days and net profit of 2% ($1,000) or $100, whichever is higher; $100 minimum wallet withdrawal.",
  },
  {
    name: "Blueberry Funded", kind: "cfd", type: "2step", account: 50000,
    p1: 10, p2: 5, maxdd: 10, ddType: "static", ddLock: 0,
    daily: 5, minDays: 3, cons: 0, tpd: TPD, split: 80, fee: 275,
    feeMode: "once", activation: 0, timeLimit: 0, payoutMin: 100, payoutEvery: 10, payoutFirst: 10, winAmt: 250, winDays: 3,
    standing: "Backed by Blueberry Markets, an established regulated broker — an unusually solid parent for a prop firm.",
    confidence: "medium",
    disputed: "The minimum trading days in each EVALUATION phase are also profit-qualified (a day counts only with >=0.5% closed profit), which is stricter than the plain min-days the engine models. Daily loss is anchored to the higher of start-of-day balance or equity.",
    note: "Every reward cycle needs 3 active trading days each closing at least 0.5% of the initial balance ($250) in realised profit; the count resets per cycle. 14-day cycles, $100 minimum, 80% split.",
  },
  {
    name: "Funded Trading Plus", kind: "cfd", type: "1phase", account: 50000,
    p1: 10, p2: 0, maxdd: 6, ddType: "trailing-eod", ddLock: 1,
    daily: 4, minDays: 0, cons: 50, tpd: TPD, split: 80, fee: 359,
    feeMode: "once", activation: 0, timeLimit: 0, payoutMin: 50, payoutCons: 50, payoutEvery: 5, payoutFirst: 0,
    standing: "Operating since 2021 with a steady public payout record and no minimum trading days.",
    confidence: "high",
    disputed: "The published $50k range is $319-$399; $359 is its midpoint.",
  },
  {
    name: "Goat Funded Trader", kind: "cfd", type: "1phase", account: 50000,
    p1: 10, p2: 0, maxdd: 6, ddType: "static", ddLock: 0,
    daily: 4, minDays: 3, cons: 0, tpd: TPD, split: 80, fee: 160,
    feeMode: "once", activation: 0, timeLimit: 0, payoutMin: 100, payoutEvery: 10, payoutFirst: 10, payoutCapAmt: 3000, winAmt: 250, winDays: 4,
    standing: "Established CFD firm with a consistent payout record and clearly published rules.",
    confidence: "low",
    note: "Rewards every 14 days after the first trade, $100 minimum. Each cycle needs 3 winning days of at least 0.5% of the initial balance ($250), and the count resets after each payout. The first two rewards are capped at 6% of account size ($3,000); the cap then lifts.",
    disputed: "The winning-day requirement rises from 3 days to 4 for accounts purchased on or after 25 July 2026. The $3,000 cap applies only to the first two payouts; the engine applies it to every payout, so later payouts read pessimistic. VERIFIED 2026-08-04: the winning-day requirement is now 4 days, not 3 - the 3-day figure is the superseded pre-25-July-2026 rule and every account bought since needs 4.",
  },  {
    name: "FXIFY (2-Phase)", kind: "cfd", type: "2step", account: 50000,
    p1: 10, p2: 5, maxdd: 10, ddType: "trailing-eod", ddLock: 1,
    daily: 4, minDays: 5, cons: 0, tpd: TPD, split: 80, fee: 379,
    feeMode: "once", activation: 0, timeLimit: 0,
    payoutMin: 50, payoutEvery: 21, payoutFirst: 0,
    standing: "Launched ~April 2023; operating entity Prime Intermarket Group Eurasia Ltd. Ranks inside the CFD top ten on tracked payout volume as of Aug 2026.",
    confidence: "medium",
    note: "2-Phase Trailing model. First payout on demand, then a monthly cycle; $50 minimum, 80% split (upgradeable at purchase).",
    disputed: "The drawdown trails the CLOSED trading balance, not intraday equity and not a strict end-of-day stamp, and it locks once the account is 10% up - modelled as trailing-EOD with a lock, which is the closest available regime but not exact. Payout cadence varies with options bought at checkout.",
  },

  {
    name: "Hola Prime", kind: "cfd", type: "1phase", account: 50000,
    p1: 10, p2: 0, maxdd: 6, ddType: "static", ddLock: 0,
    daily: 3, minDays: 2, cons: 40, tpd: TPD, split: 80, fee: 396,
    feeMode: "once", activation: 0, timeLimit: 0, payoutMin: 50, payoutEvery: 10, payoutFirst: 10, winAmt: 250, winDays: 3,
    standing: "Newer than the rest of this list but already at significant payout scale, with rules published in detail.",
    confidence: "low",
    note: "The payout cycle is chosen at purchase: the catalogued bi-weekly cycle pays an 80% split and needs 3 profitable days of at least 0.5% of the initial balance ($250) per 14-day window. Monthly pays 95% with 7 profitable days per 30; On-Demand pays 80% with a 40% consistency score and a $1,000 minimum. Minimum reward $50.",
    disputed: "The $50,000 evaluation fee is not published on any static official page (pricing renders inside the checkout app); the catalogued fee is unverified. Only the bi-weekly cycle is modelled - the Monthly cycle's 95% split would rank this firm very differently.",
  },  {
    name: "Alpha Capital Group", kind: "cfd", type: "1phase", account: 50000,
    p1: 10, p2: 0, maxdd: 6, ddType: "trailing", ddLock: 1,
    daily: 4, minDays: 1, cons: 0, tpd: TPD, split: 80, fee: 297,
    feeMode: "once", activation: 0, timeLimit: 0,
    payoutMin: 0, payoutCons: 40, payoutEvery: 0, payoutFirst: 0, payoutBuffer: 1000,
    standing: "$68.1M across 34,026 blockchain-verified payouts (Payout Junction all-time, Aug 2026) - 5th among CFD firms. UK-based, founded November 2021.",
    confidence: "high",
    note: "Single-phase evaluation. A $1,000 profit buffer gates the first withdrawal; payouts are otherwise on demand at an 80% split.",
    disputed: "Payout cadence and minimum withdrawal are not published clearly enough to model.",
  },

];

// Cut for failing the inclusion bar, kept here so the decision is not silently
// re-litigated later: Bulenox, Legends Trading, Elite Trader Funding (3.9
// Trustpilot and a disruptive migration of sim-funded traders onto different
// rules), SabioTrade, For Traders, Maven Trading and Instant Funding — all
// either short-lived, small, or without a payout record at a scale worth
// recommending. Several had attractive headline terms, which is exactly why a
// soft rule set alone is not enough to earn a place.

export function catalogCount(kind: "futures" | "cfd"): number {
  return CATALOG.filter((f) => f.kind === kind).length;
}
