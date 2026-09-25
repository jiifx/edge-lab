// Storage adapter: Tauri -> SQLite (journal.db) + image files; browser -> IndexedDB.
// Same callback API either way, so the journal code never cares which one it got.
import { toast } from "./util";
import type { Firm } from "./state";

export interface Trade {
  id: string; createdAt?: number; dateTime: string; instrument: string;
  account?: string;
  direction: "long" | "short"; session: string; setup: string;
  entryModel?: string;        // optional free-text entry model, e.g. "Liq sweep + CHOCH"
  entry: number | null; stop: number | null; target: number | null; exit: number | null;
  size: number | null; riskAmt: number | null; pnl: number | null; fees: number | null;
  R: number | null; Rmanual: boolean; followedPlan: boolean; planText: string; notes: string;
  pnlManual?: boolean;        // true = P&L typed by hand; false/undefined = derived from prices
  tags: { quality: string; mistake: string[]; condition: string[] };
  emotionBefore: number; emotionAfter: number; imageIds: string[];
  exitTime?: string | null;   // optional datetime-local close time -> holding duration
  mfe?: number | null;        // best price reached while in the trade (optional)
  mae?: number | null;        // worst price reached while in the trade (optional)
  // The same two excursions stated in R, or in money. Three bases for one pair of
  // measurements, mirroring how a RESULT can already arrive as prices, as an R
  // override or as a P&L - a journal should not force a unit on the person
  // keeping it. mfe* is signed (how far it ran in your favour); mae* is heat
  // (how far it went against you) and is read as a magnitude. Exactly one basis
  // is stored per trade; excursions() resolves whichever it finds to R.
  mfeR?: number | null;
  maeR?: number | null;
  mfeD?: number | null;   // unrealized P&L at the best point, in account currency
  maeD?: number | null;   // unrealized loss at the worst point
  // How far price got from entry BEFORE IT WOULD HAVE COME BACK TO THE STOP, in
  // R, whether or not the trade was still open.
  //
  // Deliberately NOT one of the mfe* fields. Those are bounded by the trade's own
  // life - "how far it ran WHILE OPEN" - and a mechanical target CENSORS them at
  // the target: a trader who always exits at 1.5R records 1.5R on every winner
  // and can never see from their own record whether 3R was sitting there. This is
  // the uncensored quantity, and the stop as terminating condition is what makes
  // it answerable without knowing the path - a move that returned to the stop
  // before reaching T ends at the stop, so ordering never has to be guessed.
  //
  // Only meaningful on winners. A LOSS already proves the run fell short of the
  // trade's own target, so targetSweep derives those and needs nothing logged.
  runR?: number | null;
  // The planned reward:risk, TYPED IN R, for a journal kept without prices.
  //
  // plannedRR() derived this from entry/stop/target only, which quietly locked
  // every R-first trader out of the target sweep and the Timing tab's planned-RR
  // column - the same mistake excursions() already fixed once for MFE/MAE, and
  // for the same reason: the whole point of an R-first record is that it never
  // has to name a price. Typed R wins over the prices when both are present,
  // because a number someone entered is a statement and a derived one is not.
  rrR?: number | null;
  _R?: number;
}
export interface JMeta {
  startBalance: number | null;                       // legacy (v2.0) - migrated into balances["Main"]
  accounts?: string[];                               // account folders, e.g. ["Challenge", "Personal"]
  balances?: Record<string, number | null>;          // starting balance per account
  accountFirms?: Record<string, Firm>;               // firm rules bound to an account (rule guard + odds)
  // which phase the bound account is in. Stored BESIDE accountFirms rather than
  // inside it so every existing binding, save and export keeps its exact shape;
  // an absent entry means "eval", which is what every pre-2.4 binding was.
  accountPhase?: Record<string, { phase: "eval" | "funded"; since?: string }>;
  // What one R is worth in dollars on an account. ABSENT means the account is
  // R-only: the journal shows no dollar figures for it rather than a total built
  // from whichever trades happened to carry a P&L. "fixed" = dollars per 1R;
  // "pct" = percent of the account's STARTING balance per 1R.
  // Both resolve to a CONSTANT $/R on purpose - see rValue() in journal.ts.
  rBasis?: Record<string, { mode: "fixed" | "pct"; v: number } | null>;
  lastAutoBackup?: number;                           // ms epoch of the last weekly auto-backup
}
export interface ImageRec { id: string; blob: Blob; w?: number; h?: number }

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
declare global {
  interface Window { __TAURI__?: { core?: { invoke: TauriInvoke } }; __PEL_READY?: boolean }
}
export const TAURI: TauriInvoke | null = window.__TAURI__?.core?.invoke ?? null;

function stripPrivate(t: Trade): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  const src = t as unknown as Record<string, unknown>;
  for (const k in src) if (k.charAt(0) !== "_") c[k] = src[k];
  return c;
}
export function b64ToBlob(b64: string, mime = "image/jpeg"): Blob {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
export function blobToB64(blob: Blob, cb: (b64: string | null) => void) {
  const fr = new FileReader();
  fr.onload = () => { const s = String(fr.result); cb(s.slice(s.indexOf(",") + 1)); };
  fr.onerror = () => cb(null);
  fr.readAsDataURL(blob);
}

export interface StoreApi {
  kind: "file" | "idb";
  dir?: string;
  init(cb: () => void): void;
  loadAll(cb: (list: Trade[], meta: JMeta | null) => void): void;
  persistAll(list: Trade[], meta: JMeta, cb?: (ok: boolean) => void): void;
  putImage(rec: ImageRec, cb?: (ok: boolean) => void): void;
  getImage(id: string, cb: (rec: ImageRec | null) => void): void;
  deleteImage(id: string, cb?: () => void): void;
  exportJson?(json: string, cb: (path: string | null, err?: unknown) => void): void;
}

function tauriStore(invoke: TauriInvoke): StoreApi {
  return {
    kind: "file",
    init(cb) {
      invoke("data_dir_path").then((p) => { this.dir = String(p); cb(); }).catch(() => { this.dir = ""; cb(); });
    },
    loadAll(cb) {
      invoke("db_load").then((s) => {
        try {
          const o = JSON.parse(String(s)) as { meta: JMeta | null; trades: Trade[] };
          cb(Array.isArray(o.trades) ? o.trades : [], o.meta && typeof o.meta === "object" ? o.meta : null);
        } catch { cb([], null); }
      }).catch(() => cb([], null));
    },
    persistAll(list, meta, cb) {
      invoke("db_replace_all", { trades: JSON.stringify(list.map(stripPrivate)), meta: JSON.stringify(meta) })
        .then(() => cb && cb(true))
        .catch((e) => { toast("Save failed: " + e); cb && cb(false); });
    },
    putImage(rec, cb) {
      blobToB64(rec.blob, (b64) => {
        if (!b64) { cb && cb(false); return; }
        invoke("save_image", { id: rec.id, data: b64 }).then(() => cb && cb(true)).catch(() => cb && cb(false));
      });
    },
    getImage(id, cb) {
      invoke("load_image", { id }).then((b64) => cb({ id, blob: b64ToBlob(String(b64)) })).catch(() => cb(null));
    },
    deleteImage(id, cb) {
      invoke("delete_image", { id }).then(() => cb && cb()).catch(() => cb && cb());
    },
    exportJson(json, cb) {
      invoke("export_journal", { data: json }).then((p) => cb(String(p))).catch((e) => cb(null, e));
    },
  };
}

function idbStore(): StoreApi {
  let DB: IDBDatabase | null = null;
  const os = (name: string, mode: IDBTransactionMode) => DB!.transaction(name, mode).objectStore(name);
  return {
    kind: "idb",
    init(cb) {
      if (!window.indexedDB) { cb(); return; }
      let rq: IDBOpenDBRequest;
      try { rq = indexedDB.open("propEdgeLab", 1); } catch { cb(); return; }
      rq.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains("trades")) db.createObjectStore("trades", { keyPath: "id" });
        if (!db.objectStoreNames.contains("images")) db.createObjectStore("images", { keyPath: "id" });
      };
      rq.onsuccess = (e) => { DB = (e.target as IDBOpenDBRequest).result; cb(); };
      rq.onerror = () => cb();
    },
    loadAll(cb) {
      if (!DB) { cb([], null); return; }
      try {
        const r = os("trades", "readonly").getAll();
        r.onsuccess = () => cb((r.result as Trade[]) || [], null);
        r.onerror = () => cb([], null);
      } catch { cb([], null); }
    },
    persistAll(list, _meta, cb) {
      if (!DB) { cb && cb(false); return; }
      try {
        const tx = DB.transaction("trades", "readwrite");
        const st = tx.objectStore("trades");
        st.clear();
        list.forEach((t) => st.put(stripPrivate(t)));
        tx.oncomplete = () => cb && cb(true);
        tx.onerror = () => cb && cb(false);
      } catch { cb && cb(false); }
    },
    putImage(rec, cb) {
      if (!DB) { cb && cb(false); return; }
      try {
        const r = os("images", "readwrite").put({ id: rec.id, blob: rec.blob, w: rec.w, h: rec.h });
        r.onsuccess = () => cb && cb(true);
        r.onerror = () => cb && cb(false);
      } catch { cb && cb(false); }
    },
    getImage(id, cb) {
      if (!DB) { cb(null); return; }
      try {
        const r = os("images", "readonly").get(id);
        r.onsuccess = () => cb((r.result as ImageRec) || null);
        r.onerror = () => cb(null);
      } catch { cb(null); }
    },
    deleteImage(id, cb) {
      if (!DB) { cb && cb(); return; }
      try {
        const r = os("images", "readwrite").delete(id);
        r.onsuccess = () => cb && cb();
        r.onerror = () => cb && cb();
      } catch { cb && cb(); }
    },
  };
}

export const Store: StoreApi = TAURI ? tauriStore(TAURI) : idbStore();
