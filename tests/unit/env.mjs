// The minimum browser surface the modules touch while EVALUATING (not while
// running): util.ts pins devicePixelRatio and sniffs navigator at import time,
// journal.ts reads localStorage through LS (which already swallows failures).
// Nothing here stubs a function under test.
export function installDom() {
  globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
  globalThis.document = {
    documentElement: {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { appendChild() {} },
    createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {} }),
    addEventListener() {},
  };
  if (!("navigator" in globalThis) || !globalThis.navigator?.platform) {
    Object.defineProperty(globalThis, "navigator", {
      value: { platform: "Win32", userAgent: "node" }, configurable: true,
    });
  }
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

// A deterministic empirical edge: `wins` copies of rr, the rest -1. The same
// construction the Rust anchors use, so numbers can be compared across engines.
export const edge = (wr, rr, n) => Array.from({ length: n }, (_, i) => (i < Math.round(wr * n) ? rr : -1));

// firm shapes used across the suites
export const futures = (over = {}) => ({
  type: "futures", account: 50000, p1: 6, p2: 0, maxdd: 4, ddType: "trailing-eod", ddLock: 1,
  daily: 0, minDays: 0, cons: 0, tpd: 5, split: 90, fee: 150, feeMode: "once", ...over,
});
export const twoStep = (over = {}) => ({
  type: "2step", account: 50000, p1: 10, p2: 5, maxdd: 10, ddType: "static", ddLock: 0,
  daily: 5, minDays: 4, cons: 0, tpd: 5, split: 80, fee: 375, feeMode: "once", ...over,
});
// a resolved trade with a real risk basis unless told otherwise
export const trade = (over = {}) => ({
  id: "t" + Math.random().toString(36).slice(2), dateTime: "2026-07-20T09:30",
  instrument: "ES", direction: "long", session: "New York", setup: "ORB",
  entry: null, stop: null, target: null, exit: null, size: 1,
  riskAmt: 100, pnl: 100, fees: 0, R: null, Rmanual: false,
  tags: { quality: "", mistake: [], condition: [] }, emotionBefore: 3, emotionAfter: 3, imageIds: [],
  ...over,
});
