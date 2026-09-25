// tiny DOM + misc helpers shared by every module
export function css(v: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(v).trim();
}
export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error("missing #" + id);
  return el;
}
export const $i = (id: string) => $(id) as HTMLInputElement;
export const $s = (id: string) => $(id) as HTMLSelectElement;
export const $c = (id: string) => $(id) as HTMLCanvasElement;

const DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
// The design height is pinned in data-h on first use. Never re-read the height ATTRIBUTE:
// assigning cv.height rewrites it, which on Retina (DPR=2) doubled the canvas every render.
export function fit(cv: HTMLCanvasElement) {
  // data-fw / data-fd: a forced width and pixel ratio, set only while the
  // report (report.ts) redraws a chart off-screen at its own size
  const w = cv.dataset.fw ? Number(cv.dataset.fw) : cv.clientWidth;
  const dpr = cv.dataset.fd ? Number(cv.dataset.fd) : DPR;
  if (!cv.dataset.h) cv.dataset.h = cv.getAttribute("height") || "200";
  const h = Number(cv.dataset.h);
  cv.style.height = h + "px";
  cv.width = w * dpr;
  cv.height = h * dpr;
  const ctx = cv.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

// today's date where the user IS. toISOString() is the UTC date: east of UTC it
// is still yesterday in the morning (a report made at 7am in UTC+8 was dated
// the day before).
export function localDate(): string {
  const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

// mulberry32 - deterministic PRNG (bit-identical to the Rust port)
export function mulberry(seed: number): () => number {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A Monte Carlo estimate never earns a bare "100%". Even 400 of 400 passes is a
// finite sample that happened not to fail, not a guarantee — and this number sits
// next to a spending decision, so it must not read as one. Same at the bottom:
// "0%" would claim impossibility that the sample cannot establish.
export function pctEst(x: number): string {
  const p = Math.round(x * 100);
  if (p >= 100) return ">99%";
  if (p <= 0) return "<1%";
  return p + "%";
}

// Blend two #rrggbb colours. Used to paint a chart band from a continuous
// quantity instead of bucketing it: three hard buckets meant a survival estimate
// wobbling by one point across a threshold repainted a whole column a different
// colour, so the chart claimed a bigger size was safer than a smaller one. A ramp
// makes a one-point difference look like a one-point difference.
export function mixHex(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const u = Math.max(0, Math.min(1, t)), x = p(a), y = p(b);
  // a token can come back empty if the variable is missing; fail visible, not black
  if (x.some(isNaN) || y.some(isNaN)) return a || b;
  return "#" + [0, 1, 2].map((i) => Math.round(x[i] + (y[i] - x[i]) * u).toString(16).padStart(2, "0")).join("");
}

export function esc(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

export function hasNum(v: unknown): boolean {
  return v != null && v !== "" && isFinite(Number(v));
}

// Mac uses Cmd where Windows uses Ctrl. The handlers already accept either
// (ctrlKey || metaKey); this is only about what the labels claim, since pressing
// the literal Control key on a Mac does nothing.
export const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent
);
export function applyShortcutLabels() {
  if (!IS_MAC) return;
  const pretty = (s: string) => s.replace(/^mod\+/, "⌘").replace("Enter", "↩");
  document.querySelectorAll<HTMLElement>("[data-kbd]").forEach((el) => { el.textContent = pretty(el.getAttribute("data-kbd")!); });
  document.querySelectorAll<HTMLElement>("[data-kbdtitle]").forEach((el) => { el.title = pretty(el.getAttribute("data-kbdtitle")!); });
}

export const LS = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : (JSON.parse(v) as T);
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch { /* full or blocked - non-fatal */ }
  },
};

// ---------------------------------------------------------------------------
// ONE HEAVY JOB AT A TIME, IN SLICES
// ---------------------------------------------------------------------------
//
// This app has five panels that each want seconds of Monte Carlo: the drawdown
// estimator, the edge band, the firm-plan builder, the catalogue scorer and the
// journal odds panel. Every one of them was individually well-behaved - each
// chunked its own work across macrotasks - and the app still became unclickable,
// because "chunked" was never the same as "small", and nothing stopped four of
// them running at once. A setTimeout chain that does 300ms of work per tick
// yields to the browser exactly as often as one doing 3ms, and gives it nothing.
//
// So: a single queue, one job at a time, and a REAL time budget inside each
// tick. A job is a step function returning true when it is finished; the pump
// calls it repeatedly until the slice is spent, then yields. Input handlers land
// between slices, which is the whole point - the user can always click.
//
// The budget is 10ms because a frame is ~16ms: a slice that fits inside one
// frame cannot drop one.
const SLICE_MS = 10;
interface Job { step: () => boolean; done?: () => void; cancelled: boolean }
const jobQ: Job[] = [];
let pumping = false;
export function runJob(step: () => boolean, done?: () => void): () => void {
  const j: Job = { step, done, cancelled: false };
  jobQ.push(j);
  pump();
  return () => { j.cancelled = true; };
}
function pump() {
  if (pumping) return;
  pumping = true;
  const tick = () => {
    const j = jobQ[0];
    if (!j) { pumping = false; return; }
    if (j.cancelled) { jobQ.shift(); setTimeout(tick, 0); return; }
    const t0 = Date.now();
    let finished = false;
    do {
      try { finished = j.step(); }
      // a job that throws must not wedge the queue for every other panel
      catch (e) { finished = true; }
    } while (!finished && !j.cancelled && Date.now() - t0 < SLICE_MS);
    if (finished || j.cancelled) {
      jobQ.shift();
      if (finished && !j.cancelled && j.done) { try { j.done(); } catch (e) { /* a render is not the queue's problem */ } }
    }
    setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
}

let toastT: ReturnType<typeof setTimeout> | null = null;
export function toast(msg: string) {
  const el = $("toast");
  el.textContent = msg;
  el.style.display = "block";
  if (toastT) clearTimeout(toastT);
  // long messages (an import with notes) stay up long enough to read
  toastT = setTimeout(() => { el.style.display = "none"; }, Math.max(2800, msg.length * 45));
}
// a toast with one action (Undo). `onExpire` runs if the action is not taken
// before the toast closes - that is where anything irreversible belongs.
export function toastAction(msg: string, label: string, onAction: () => void, onExpire: () => void, ms = 9000) {
  const el = $("toast");
  el.textContent = msg + " ";
  const b = document.createElement("button");
  b.type = "button"; b.className = "toastbtn"; b.textContent = label;
  let done = false;
  const finish = (acted: boolean) => {
    if (done) return;
    done = true;
    if (toastT) { clearTimeout(toastT); toastT = null; }
    el.style.display = "none";
    if (acted) onAction(); else onExpire();
  };
  b.addEventListener("click", () => finish(true));
  el.appendChild(b);
  el.style.display = "block";
  if (toastT) clearTimeout(toastT);
  toastT = setTimeout(() => finish(false), ms);
}

export interface AskButton { label: string; kind: "" | "primary" | "danger"; value: unknown }
export function ask(msgHtml: string, buttons: AskButton[], cb: (v: unknown) => void) {
  $("askMsg").innerHTML = msgHtml;
  const wrap = $("askBtns");
  wrap.innerHTML = "";
  buttons.forEach((b) => {
    const el = document.createElement("button");
    el.className = "btn" + (b.kind === "primary" ? " primary" : b.kind === "danger" ? " danger" : "");
    el.textContent = b.label;
    el.addEventListener("click", () => { $("askOv").classList.add("hide"); cb(b.value); });
    wrap.appendChild(el);
  });
  $("askOv").classList.remove("hide");
  (wrap.querySelector("button") as HTMLButtonElement | null)?.focus();
}

// shared hover tooltip for canvas charts. resolve() gets the cursor position in
// canvas CSS pixels and returns tip HTML, or null to hide. Assigned (not added)
// so re-wiring the same canvas after a re-render never stacks handlers.
let tipEl: HTMLElement | null = null;
function tip(): HTMLElement {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.id = "chartTip";
    document.body.appendChild(tipEl);
  }
  return tipEl;
}
export function chartTip(cv: HTMLCanvasElement, resolve: (x: number, y: number, w: number, h: number) => string | null) {
  cv.onmousemove = (e) => {
    const r = cv.getBoundingClientRect();
    const s = resolve(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    const el = tip();
    if (!s) { el.style.display = "none"; return; }
    // a chart tip is one short line; drop the prose wrapping a [data-tip] left on
    el.classList.remove("wrap");
    el.innerHTML = s;
    el.style.display = "block";
    const vw = window.innerWidth, tw = el.offsetWidth;
    let x = e.clientX + 14;
    if (x + tw > vw - 8) x = e.clientX - tw - 14;
    el.style.left = x + "px";
    el.style.top = Math.max(6, e.clientY - el.offsetHeight - 12) + "px";
  };
  cv.onmouseleave = () => { tip().style.display = "none"; };
}

// Prose tooltips for any [data-tip] element, sharing the chart tip element so
// there is only ever one floating box. Handlers are ASSIGNED, not added, so
// re-rendering a panel and re-wiring it can never stack them. Focus opens the
// tip too - the "i" dots are tabbable, so keyboard users get the same reading.
export function wireTips(root: HTMLElement | Document) {
  root.querySelectorAll<HTMLElement>("[data-tip]").forEach((el) => {
    const show = (x: number, y: number) => {
      const t = tip();
      t.innerHTML = el.getAttribute("data-tip") || "";
      t.classList.add("wrap");
      t.style.display = "block";
      const vw = window.innerWidth;
      let left = x + 14;
      if (left + t.offsetWidth > vw - 8) left = Math.max(8, x - t.offsetWidth - 14);
      t.style.left = left + "px";
      t.style.top = Math.max(6, y - t.offsetHeight - 12) + "px";
    };
    const hide = () => { const t = tip(); t.classList.remove("wrap"); t.style.display = "none"; };
    el.onmouseenter = (e) => show(e.clientX, e.clientY);
    el.onmousemove = (e) => show(e.clientX, e.clientY);
    el.onmouseleave = hide;
    el.onfocus = () => { const r = el.getBoundingClientRect(); show(r.left + r.width / 2, r.bottom + 4); };
    el.onblur = hide;
  });
}

// cross-module wiring (populated by main.ts; avoids import cycles)
export const hooks: {
  render: () => void;
  saveSim: () => void;
  renderJournal: () => void;
  applyJournalEdge: () => void;
  clearJournalEdge: () => void;
  getMode: () => string;
  // the journal changed the firm (adopted a suggestion): let the simulator
  // refresh its form, summary and charts without importing sim.ts
  firmChanged: () => void;
  // the counterfactual readout lives in the Simulator's rail but is computed in
  // journal.ts, and it has to follow the FIRM and the RISK sliders as well as
  // the trades - so the simulator's own render drives it. `fast` is the drag
  // tier: reuse the last answer rather than run 1200 sims a frame.
  renderEdgeCut: (fast?: boolean) => void;
  // Read the edge sliders into S. journal.ts needs this when it hands the engine
  // back on "Use my journal" off, and it must go through the ONE implementation:
  // the four-line copy it used to carry ignored S.payMode and installed a profit
  // factor as a reward:risk ratio.
  syncSliders: () => void;
} = {
  render: () => {},
  saveSim: () => {},
  renderJournal: () => {},
  applyJournalEdge: () => {},
  clearJournalEdge: () => {},
  getMode: () => "sim",
  firmChanged: () => {},
  renderEdgeCut: () => {},
  syncSliders: () => {},
};
