// bootstrap: wire modules, restore state, load journal, first render
import { hooks, ask } from "./util";
import { wireSim, render, saveSim, restoreSim, syncSliders, sumStrat, sumFirm, firmToForm, setMode, getMode } from "./sim";
import { wireJournal, renderJournal, applyJournalEdge, clearJournalEdge, renderEdgeCut, loadTrades, maybeAutoBackup } from "./journal";
import { Store, TAURI } from "./store";
import { $, $i, LS, esc, applyShortcutLabels } from "./util";

// reload: button + F5 / Ctrl+R / Cmd+R; guard against losing an open trade edit
function doReload() {
  if (!$("editorOv").classList.contains("hide")) {
    ask("Reload the app? Unsaved changes in the open trade editor are lost.", [
      { label: "Keep editing", kind: "", value: false },
      { label: "Reload", kind: "danger", value: true },
    ], (yes) => { if (yes) location.reload(); });
    return;
  }
  location.reload();
}
$("reloadBtn").addEventListener("click", doReload);

// the user manual: explanations live there, not on the screens. The desktop
// app ships it as a bundled resource and opens it in the OS viewer; the
// single-file browser build expects it beside the HTML file.
const MANUAL_FILE = "Edge Lab - User Manual.pdf";
$("manualBtn").addEventListener("click", () => {
  if (TAURI) TAURI("open_manual").catch((e: unknown) => ask("Could not open the manual: " + esc(String(e)), [{ label: "OK", kind: "", value: true }], () => {}));
  else window.open(encodeURI(MANUAL_FILE), "_blank");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && (e.key === "r" || e.key === "R"))) {
    e.preventDefault();
    doReload();
  }
});

hooks.render = render;
hooks.saveSim = saveSim;
hooks.renderJournal = renderJournal;
hooks.applyJournalEdge = applyJournalEdge;
hooks.clearJournalEdge = clearJournalEdge;
hooks.getMode = getMode;
hooks.renderEdgeCut = renderEdgeCut;
hooks.syncSliders = syncSliders;
hooks.firmChanged = () => { firmToForm(); sumFirm(); render(); saveSim(); };

wireSim();
wireJournal();
applyShortcutLabels();

// The backend degrades instead of panicking when the data folder is unusable
// (macOS TCC on ~/Documents). If it fell back, say so where storage is described.
if (TAURI) {
  TAURI("storage_note").then((n) => {
    if (!n) return;
    const el = $("jStorageNote");
    // n is a system path / SQLite error, not attacker data, but keep it a text node
    el.textContent = "";
    const b = document.createElement("b");
    b.textContent = "Storage warning. ";
    el.appendChild(b);
    el.appendChild(document.createTextNode(String(n)));
    el.className = "small cell-caution";
  }).catch(() => { /* older backend without the command */ });
}

const wantJournalEdge = restoreSim();
firmToForm();
sumFirm();
syncSliders();
sumStrat();

Store.init(() => {
  if (Store.kind === "file" && Store.dir) {
    $("jDataLoc").classList.remove("hide");
    $("jDataPath").textContent = Store.dir;
    $("jDataPath").title = Store.dir;
  }
  loadTrades(() => {
    renderJournal();
    if (wantJournalEdge) {
      $i("useJournal").checked = true;
      applyJournalEdge();
      // the strategy bar was written above, before the trades had loaded, so it
      // still claimed "sliders" while every tab was resampling the journal
      sumStrat();
    } else {
      render();
    }
    const lastMode = LS.get<string>("pel_mode", "sim");
    if (lastMode === "journal") setMode("journal");
    window.__PEL_READY = true;
    maybeAutoBackup();
  });
});
render();

// keep TS aware this is used (Tauri detection happens in store.ts)
void TAURI;
