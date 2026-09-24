# Generate a 1,000-trade Edge Lab backup (JSON import format, version 3) with a
# modest, real edge that has structure the Edge report / Timing tab can find.
#
#   python samples/generate_sample.py samples/sample-1000-trades.json
#
# Deterministic (fixed seed). The optional second argument scales the edge;
# 2.7 is what the shipped sample uses.
import json, math, random, datetime as dt, sys

rnd = random.Random(20260924)
OUT = sys.argv[1]
ACCT = "Sample 50k"
RISK = 200.0          # $ per 1R
MU0 = float(sys.argv[2]) if len(sys.argv) > 2 else 2.7
FEE = 3.70            # round-turn commissions per trade

INSTR = {  # symbol: (price level, stop points, point value, size, tick)
    "MNQ": (21000.0, 20.0, 2.0, 5, 0.25),
    "MES": (5900.0, 8.0, 5.0, 5, 0.25),
}
SETUPS = ["Opening range break", "VWAP reclaim", "Trend pullback", "Failed breakout"]
MODELS = ["Liq sweep + CHOCH", "Break and retest", "Session open drive", "Inside bar break"]
CONDS = ["Trend day", "Range / chop", "High volatility", "Low volume", "News day", "Open drive", "Reversal"]

def rtick(x, tick):
    return round(round(x / tick) * tick, 2)

def session_time(day):
    # trader in New York time: London pre-market, New York cash session, Asia evening
    s = rnd.choices(["New York", "London", "Asia"], [0.62, 0.26, 0.12])[0]
    if s == "New York":
        h, m = rnd.choice([9, 9, 10, 10, 11, 13, 14]), rnd.randrange(0, 60)
        if h == 9 and m < 30: m += 30
    elif s == "London":
        h, m = rnd.choice([3, 4, 5, 6]), rnd.randrange(0, 60)
    else:
        h, m = rnd.choice([19, 20, 21]), rnd.randrange(0, 60)
    return s, dt.datetime(day.year, day.month, day.day, h, m)

trades = []
day = dt.date(2025, 5, 5)
n = 0
tid = 0
while n < 1000:
    if day.weekday() < 5 and rnd.random() > 0.08:        # some days off
        k = rnd.choices([1, 2, 3, 4], [0.22, 0.38, 0.28, 0.12])[0]
        slots = sorted((session_time(day) for _ in range(k)), key=lambda x: x[1])
        losses_today = 0
        for nth, (sess, t0) in enumerate(slots, 1):
            if n >= 1000: break
            sym = rnd.choices(["MNQ", "MES"], [0.65, 0.35])[0]
            px, stop_pts, pv, size, tick = INSTR[sym]
            long_ = rnd.random() < 0.58
            setup = rnd.choice(SETUPS)
            model = rnd.choice(MODELS)
            # quality: tilt after losses makes forced / revenge trades likelier
            q_w = [0.30, 0.38, 0.14, 0.12, 0.06] if losses_today < 2 else [0.12, 0.30, 0.14, 0.26, 0.18]
            quality = rnd.choices(["A+ setup", "B setup", "C setup", "Forced", "Revenge trade"], q_w)[0]
            cond = rnd.sample(CONDS, rnd.choice([1, 1, 2]))
            target_R = rnd.choices([2.0, 1.5, 3.0], [0.7, 0.2, 0.1])[0]

            # ---- the edge: mean of the favourable run before the stop, in R ----
            mu = MU0
            mu *= {"A+ setup": 1.35, "B setup": 1.05, "C setup": 0.85, "Forced": 0.62, "Revenge trade": 0.5}[quality]
            mu *= {"New York": 1.08, "London": 1.05, "Asia": 0.78}[sess]
            mu *= 1.0 if long_ else 0.88
            mu *= {"Opening range break": 1.08, "VWAP reclaim": 1.0, "Trend pullback": 1.04, "Failed breakout": 0.9}[setup]
            if "Trend day" in cond: mu *= 1.12
            if "Range / chop" in cond: mu *= 0.85
            if nth >= 4: mu *= 0.75
            run = rnd.expovariate(1.0 / mu)                  # how far it got before the stop
            mistakes = []
            if quality in ("Forced", "Revenge trade") and rnd.random() < 0.5: mistakes.append(rnd.choice(["Chased", "Outside plan", "Overtraded"]))
            scratch = rnd.random() < 0.05
            early = (not scratch) and run >= target_R and rnd.random() < 0.08

            if scratch:
                R = 0.0; mfe = round(min(run, 0.6), 2); mae = round(rnd.uniform(0.1, 0.6), 2); runR = None
                note = "Stalled at entry, scratched it."
            elif run >= target_R and not early:
                R = target_R; mfe = target_R; mae = round(rnd.uniform(0.0, 0.85), 2); runR = round(run, 2)
                note = "Clean move, held to target."
            elif early:
                R = round(rnd.uniform(0.4, target_R * 0.8), 2); mistakes.append("Exited early")
                mfe = round(R + rnd.uniform(0.1, 0.6), 2); mae = round(rnd.uniform(0.0, 0.7), 2); runR = round(run, 2)
                note = "Took it off early; it went on to target."
            else:
                slip = rnd.choices([0.0, rnd.uniform(0.02, 0.15), rnd.uniform(0.2, 0.45)], [0.7, 0.25, 0.05])[0]
                if slip > 0.19: mistakes.append("Moved stop")
                R = -round(1.0 + slip, 2); mfe = round(run, 2); mae = round(1.0 + slip, 2); runR = None
                note = "Failed and came back through the stop."
            if R < 0: losses_today += 1

            # prices consistent with R
            entry = rtick(px * (1 + rnd.uniform(-0.04, 0.04)), tick)
            sgn = 1 if long_ else -1
            stop = rtick(entry - sgn * stop_pts, tick)
            target = rtick(entry + sgn * stop_pts * target_R, tick)
            exitp = rtick(entry + sgn * stop_pts * R, tick)
            Rp = (exitp - entry) / (entry - stop)
            pnl = round(Rp * RISK - FEE, 2)
            hold = rnd.randint(25, 140) if R > 0 else rnd.randint(4, 45)
            emo_b = 1 if quality == "A+ setup" else rnd.choice([1, 2, 2, 3]) if losses_today < 2 else rnd.choice([3, 4, 4, 5])
            emo_a = min(5, max(1, emo_b + (1 if R < 0 else -1 if R > 0 else 0)))
            tid += 1
            trades.append({
                "id": "s1k" + str(tid).zfill(4),
                "createdAt": int(t0.timestamp() * 1000),
                "dateTime": t0.strftime("%Y-%m-%dT%H:%M"),
                "exitTime": (t0 + dt.timedelta(minutes=hold)).strftime("%Y-%m-%dT%H:%M"),
                "account": ACCT, "instrument": sym, "direction": "long" if long_ else "short",
                "session": sess, "setup": setup, "entryModel": model,
                "entry": entry, "stop": stop, "target": target, "exit": exitp, "size": size,
                "riskAmt": RISK, "pnl": pnl, "fees": FEE,
                "R": None, "Rmanual": False, "pnlManual": False,
                "followedPlan": quality in ("A+ setup", "B setup") and not mistakes,
                "planText": setup + " off " + model.lower() + ", stop beyond the structure, target " + str(target_R) + "R.",
                "notes": note,
                "tags": {"quality": quality, "mistake": sorted(set(mistakes)), "condition": cond},
                "emotionBefore": emo_b, "emotionAfter": emo_a,
                "mfeR": mfe, "maeR": mae, "mfe": None, "mae": None, "mfeD": None, "maeD": None,
                "runR": runR, "rrR": None, "imageIds": [],
            })
            n += 1
    day += dt.timedelta(days=1)

last = dt.datetime.strptime(trades[-1]["dateTime"], "%Y-%m-%dT%H:%M")
shift = dt.timedelta(weeks=((last.date() - dt.date(2026, 9, 23)).days + 6) // 7)
for t in trades:
    for k in ("dateTime", "exitTime"):
        t[k] = (dt.datetime.strptime(t[k], "%Y-%m-%dT%H:%M") - shift).strftime("%Y-%m-%dT%H:%M")
    t["createdAt"] = int(dt.datetime.strptime(t["dateTime"], "%Y-%m-%dT%H:%M").timestamp() * 1000)

out = {
    "app": "prop-edge-lab", "version": 3, "exportedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
    "meta": {
        "startBalance": None, "accounts": [ACCT], "balances": {ACCT: 50000},
        "accountFirms": {}, "accountPhase": {ACCT: {"phase": "eval"}},
        "rBasis": {ACCT: {"mode": "fixed", "v": RISK}},
    },
    "trades": trades, "images": [],
}
json.dump(out, open(OUT, "w", encoding="utf-8"))

# quick summary of what was generated (R from prices, fees ignored)
rs = [(t["exit"] - t["entry"]) / (t["entry"] - t["stop"]) for t in trades]
dec = [r for r in rs if abs(r) > 1e-9]
w = [r for r in dec if r > 0]
print(len(trades), "trades", trades[0]["dateTime"][:10], "to", trades[-1]["dateTime"][:10])
print("win rate %.1f%%  expectancy %+.3fR  total %+.1fR  PF %.2f" % (
    100 * len(w) / len(dec), sum(rs) / len(rs), sum(rs), sum(w) / -sum(r for r in dec if r < 0)))
for key in ("session", "direction"):
    g = {}
    for t, r in zip(trades, rs): g.setdefault(t[key], []).append(r)
    print(key, {k: "%+.2fR n=%d" % (sum(v) / len(v), len(v)) for k, v in g.items()})
g = {}
for t, r in zip(trades, rs): g.setdefault(t["tags"]["quality"], []).append(r)
print("quality", {k: "%+.2fR n=%d" % (sum(v) / len(v), len(v)) for k, v in g.items()})
