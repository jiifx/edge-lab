// CSV import and the built-in sample journal. The CSV reader is the one place a
// stranger's spreadsheet reaches the journal, so every guess it makes is pinned:
// a date it cannot place is asked about, never assumed; a number it cannot read
// is dropped, never zero; the same file imported twice gets the same ids.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installDom } from "./env.mjs";
import { buildOnce } from "./build.mjs";

installDom();
const E = await import(await buildOnce("importcsv"));
const { parseCsvRows, csvNum, csvDate, csvDateOrder, csvToTrades, generateSample, SAMPLE_ACCT } = E;

test("rows: quotes, escaped quotes, embedded delimiters and newlines, CRLF", () => {
  const rows = parseCsvRows('Date,Notes,R\r\n2025-01-02,"held, then ""scaled""\nout",1.5\r\n\r\n2025-01-03,x,-1\r\n');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], ["2025-01-02", 'held, then "scaled"\nout', "1.5"]);
});

test("rows: the delimiter is read off the header (semicolon, tab)", () => {
  assert.deepEqual(parseCsvRows("Date;R\n2025-01-02;1,5")[1], ["2025-01-02", "1,5"]);
  assert.deepEqual(parseCsvRows("Date\tR\n2025-01-02\t-1")[1], ["2025-01-02", "-1"]);
});

test("numbers: currency, grouping, decimal comma, accounting negatives, an R suffix", () => {
  assert.equal(csvNum("$1,234.50"), 1234.5);
  assert.equal(csvNum("1.234,50"), 1234.5);
  assert.equal(csvNum("1,5"), 1.5);
  assert.equal(csvNum("1,234"), 1234);
  assert.equal(csvNum("(120)"), -120);
  assert.equal(csvNum("-1.5R"), -1.5);
  assert.equal(csvNum("€ -80"), -80);
  // unreadable is null, never 0 - a zero is a real scratch trade
  assert.equal(csvNum(""), null);
  assert.equal(csvNum("n/a"), null);
  assert.equal(csvNum("--"), null);
});

test("dates: ISO, slashed either order, 12-hour clocks, seconds", () => {
  assert.equal(csvDate("2025-03-04 09:31:07", "mdy"), "2025-03-04T09:31");
  assert.equal(csvDate("2025-03-04T14:05", "dmy"), "2025-03-04T14:05");
  assert.equal(csvDate("03/04/2025 2:05 PM", "mdy"), "2025-03-04T14:05");
  assert.equal(csvDate("03/04/2025 12:10 am", "dmy"), "2025-04-03T00:10");
  assert.equal(csvDate("4.3.25", "dmy"), "2025-03-04T00:00");
  assert.equal(csvDate("13/13/2025", "mdy"), "");
  assert.equal(csvDate("yesterday", "mdy"), "");
});

test("date order comes from the file; a file that never says is asked, not guessed", () => {
  assert.equal(csvDateOrder(["01/02/2025", "25/02/2025"]), "dmy");
  assert.equal(csvDateOrder(["01/02/2025", "02/25/2025"]), "mdy");
  assert.equal(csvDateOrder(["01/02/2025", "03/04/2025"]), null);
  const r = csvToTrades("Date,R\n01/02/2025,1\n03/04/2025,-1\n", null, "Main");
  assert.equal(r.needOrder, true);
  assert.equal(r.trades, undefined);
  const r2 = csvToTrades("Date,R\n01/02/2025,1\n03/04/2025,-1\n", "dmy", "Main");
  assert.equal(r2.trades[0].dateTime, "2025-02-01T00:00");
});

test("a minimal R file becomes manual-R trades on the fallback account", () => {
  const r = csvToTrades("date,r,side,symbol,setup\n2025-01-02 09:30,2,Sell,MNQ,ORB\n2025-01-02 10:00,-1,buy,MES,\n", null, "Acct A");
  assert.equal(r.trades.length, 2);
  const [a, b] = r.trades;
  assert.equal(a.R, 2); assert.equal(a.Rmanual, true);
  assert.equal(a.direction, "short"); assert.equal(b.direction, "long");
  assert.equal(a.instrument, "MNQ"); assert.equal(a.setup, "ORB");
  assert.equal(a.account, "Acct A");
  assert.match(a.id, /^[A-Za-z0-9_-]{1,64}$/);   // the Rust safe_id rule
});

test("P&L with a Risk column yields R; P&L alone is counted as having no R", () => {
  const r = csvToTrades("Date,P&L,Risk\n2025-01-02,300,150\n2025-01-03,-150,150\n2025-01-04,90,\n", null, "Main");
  assert.equal(r.trades.length, 3);
  assert.equal(r.trades[0].riskAmt, 150);
  assert.equal(r.trades[0].R, null);
  assert.equal(r.noR, 1);
});

test("rows without a date or a result are skipped and counted", () => {
  const r = csvToTrades("Date,R\n2025-01-02,1\n,1\n2025-01-03,\nnot a date,2\n", null, "Main");
  assert.equal(r.trades.length, 1);
  assert.equal(r.skipped, 3);
});

test("missing required columns are named in the error", () => {
  assert.match(csvToTrades("When,R\n2025-01-02,1\n", null, "Main").error, /date/i);
  assert.match(csvToTrades("Date,Symbol\n2025-01-02,MNQ\n", null, "Main").error, /result/i);
});

test("ids are stable across imports and distinct for identical rows", () => {
  const f = "Date,R\n2025-01-02,1\n2025-01-02,1\n2025-01-03,-1\n";
  const a = csvToTrades(f, null, "Main").trades.map((t) => t.id);
  const b = csvToTrades(f, null, "Main").trades.map((t) => t.id);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 3);
});

test("sample: deterministic, 1,000 trades, a real edge, ends just before the given day", () => {
  const end = Date.UTC(2026, 8, 24);
  const a = generateSample(end), b = generateSample(end);
  assert.deepEqual(a.trades, b.trades);
  assert.equal(a.trades.length, 1000);
  assert.ok(a.trades.every((t) => t.account === SAMPLE_ACCT));
  const rs = a.trades.map((t) => (t.exit - t.entry) / (t.entry - t.stop));
  const mean = rs.reduce((s, v) => s + v, 0) / rs.length;
  assert.ok(mean > 0.2 && mean < 0.35, "expectancy " + mean);
  const last = a.trades.map((t) => t.dateTime).sort().at(-1);
  assert.ok(last < "2026-09-24" && last >= "2026-09-16", "last trade " + last);
  // only the dates move with the end day - the trades themselves do not
  const c = generateSample(Date.UTC(2027, 0, 5));
  assert.deepEqual(c.trades.map((t) => t.R ?? t.exit), a.trades.map((t) => t.R ?? t.exit));
  assert.notEqual(c.trades[0].dateTime, a.trades[0].dateTime);
});

test("sample: the shipped JSON file is exactly what the generator writes", () => {
  const file = JSON.parse(readFileSync(new URL("../../samples/sample-1000-trades.json", import.meta.url), "utf-8"));
  assert.deepEqual(file.trades, generateSample(Date.UTC(2026, 8, 24)).trades,
    "samples/sample-1000-trades.json is stale - run node scripts/sample.mjs");
});

// ---- found by the 2.18.1 bug sweep: each of these read wrong or not at all ----
test("a separate Time column is joined to a date-only Date column, in either order", () => {
  const a = csvToTrades("Date,Time,R\n2025-03-04,09:31,1\n2025-03-04,2:05 PM,-1\n", null, "M").trades;
  assert.deepEqual(a.map((t) => t.dateTime), ["2025-03-04T09:31", "2025-03-04T14:05"]);
  const b = csvToTrades("Time,Date,R\n09:31,2025-03-04,1\n", null, "M").trades;
  assert.equal(b[0].dateTime, "2025-03-04T09:31");
  const c = csvToTrades("Open Date,Open Time,Close Date,Close Time,R\n2025-03-04,23:10,2025-03-05,01:20,1\n", null, "M").trades;
  assert.equal(c[0].dateTime, "2025-03-04T23:10");
  assert.equal(c[0].exitTime, "2025-03-05T01:20");
});

test("an exit given as a bare clock time lands on the entry's day, or the next when earlier", () => {
  const t = csvToTrades("Date,Exit time,R\n2025-03-04 23:10,00:20,1\n2025-03-04 09:00,10:15,1\n", null, "M").trades;
  assert.equal(t[0].exitTime, "2025-03-05T00:20");
  assert.equal(t[1].exitTime, "2025-03-04T10:15");
});

test("impossible calendar days are refused, not rolled into the next month", () => {
  assert.equal(csvDate("2025-02-31", "mdy"), "");
  assert.equal(csvDate("2024-02-29", "mdy"), "2024-02-29T00:00");
  assert.equal(csvDate("2025-02-29", "mdy"), "");
  assert.equal(csvDate("31/04/2025", "dmy"), "");
});

test("month names, weekday prefixes and Excel serial dates", () => {
  assert.equal(csvDate("Mar 4, 2025 9:31 AM", "mdy"), "2025-03-04T09:31");
  assert.equal(csvDate("4 March 2025", "mdy"), "2025-03-04T00:00");
  assert.equal(csvDate("04-Mar-2025 14:05", "mdy"), "2025-03-04T14:05");
  assert.equal(csvDate("Tue, 4 Mar 2025", "mdy"), "2025-03-04T00:00");
  assert.equal(csvDate("45720", "mdy"), "2025-03-04T00:00");
  assert.equal(csvDate("45720.5", "mdy"), "2025-03-04T12:00");
  assert.equal(csvDate("Foo 4, 2025", "mdy"), "");
});

test("Excel's sep= line names the delimiter", () => {
  const t = csvToTrades("sep=;\nDate;R\n2025-03-04;1,5\n", null, "M").trades;
  assert.equal(t.length, 1);
  assert.equal(t[0].R, 1.5);
});

test("a typographic minus is a minus, not an unreadable row", () => {
  assert.equal(csvNum("−1.5"), -1.5);
  assert.equal(csvNum("–200"), -200);
  assert.equal(csvNum("1'234.50"), 1234.5);
  assert.equal(csvNum("1.2.3"), null);
});

test("a MetaTrader-style export (dotted dates, Type, Profit) reads", () => {
  const t = csvToTrades("Open Time,Type,Symbol,Close Time,Profit\n2025.03.04 09:31:00,sell,NAS100,2025.03.04 10:02:11,-45.20\n", null, "M").trades;
  assert.equal(t[0].dateTime, "2025-03-04T09:31");
  assert.equal(t[0].exitTime, "2025-03-04T10:02");
  assert.equal(t[0].direction, "short");
  assert.equal(t[0].pnl, -45.2);
});

test("P&L (R) is read as an R column", () => {
  const t = csvToTrades("Date,P&L (R),Risk ($)\n2025-03-04,1.5,200\n", null, "M").trades;
  assert.equal(t[0].R, 1.5);
  assert.equal(t[0].pnl, null);
  assert.equal(t[0].riskAmt, 200);
});

test("trades differing only in direction or notes are different trades across files", () => {
  const a = csvToTrades("Date,Side,R\n2025-03-04,long,1\n", null, "M").trades[0].id;
  const b = csvToTrades("Date,Side,R\n2025-03-04,short,1\n", null, "M").trades[0].id;
  assert.notEqual(a, b);
});

test("an account named like an object-prototype key falls back to the default account", () => {
  const t = csvToTrades("Date,Account,R\n2025-03-04,__proto__,1\n2025-03-04,constructor,1\n", null, "Main").trades;
  assert.deepEqual(t.map((x) => x.account), ["Main", "Main"]);
});

test("ids stay unique across a large file", () => {
  let rows = "Date,R\n";
  for (let i = 0; i < 20000; i++) rows += "2025-01-01 " + String(Math.floor(i / 60) % 24).padStart(2, "0") + ":" + String(i % 60).padStart(2, "0") + "," + (i / 1000).toFixed(3) + "\n";
  const ids = csvToTrades(rows, null, "M").trades.map((t) => t.id);
  assert.equal(new Set(ids).size, 20000);
});
