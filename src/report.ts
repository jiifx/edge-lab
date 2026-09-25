// "Save as image": the Validate verdict, its numbers and its two charts drawn
// onto one 1200x675 PNG, so a result can be shared without a screenshot of the
// whole window (file names, account list and all). It copies what is ON SCREEN
// - it computes nothing, so the image can never disagree with the app.
import { $, css, toast } from "./util";
import { TAURI } from "./store";
import { redrawValidateCharts } from "./sim";

const W = 1200, H = 675, PAD = 44;

function clean(s: string | null): string { return (s || "").replace(/\s+/g, " ").trim(); }
function txt(id: string): string { return clean($(id).textContent); }
// a readout is "value" plus a smaller .sub line (its range); textContent would
// run them together ("55%46-64%"), so they are read apart
function valSub(id: string): [string, string] {
  const el = $(id), sub = el.querySelector(".sub");
  let v = "";
  el.childNodes.forEach((n) => { if (n !== sub) v += n.textContent || ""; });
  return [clean(v), clean(sub ? sub.textContent : "")];
}

// draw `s` wrapped to `maxW`, returning the y below the last line
function wrap(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, maxW: number, lh: number, maxLines = 3): number {
  const words = s.split(" ");
  let line = "", lines = 0;
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (ctx.measureText(t).width > maxW && line) {
      ctx.fillText(line, x, y); y += lh; line = w;
      if (++lines >= maxLines - 1) { ctx.fillText(words.slice(words.indexOf(w)).join(" "), x, y); return y + lh; }
    } else line = t;
  }
  if (line) { ctx.fillText(line, x, y); y += lh; }
  return y;
}

// the on-screen canvas is sized to its column, which can be narrow; redraw the
// chart at the report's own size (and 2x), copy it, then put it back
function drawCharts(ctx: CanvasRenderingContext2D, boxes: [string, number, number, number][]) {
  const cvs = boxes.map(([id]) => document.getElementById(id) as HTMLCanvasElement | null);
  boxes.forEach(([, , , w], i) => { const c = cvs[i]; if (c) { c.dataset.fw = String(w); c.dataset.fd = "2"; } });
  try {
    redrawValidateCharts();
    boxes.forEach(([, x, y, w], i) => {
      const c = cvs[i];
      if (c && c.width && c.height) ctx.drawImage(c, x, y, w, c.height / 2);
    });
  } finally {
    cvs.forEach((c) => { if (c) { delete c.dataset.fw; delete c.dataset.fd; } });
    redrawValidateCharts();
  }
}

export function buildReport(): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = W * 2; cv.height = H * 2;          // 2x so it stays sharp when shared
  const ctx = cv.getContext("2d")!;
  ctx.scale(2, 2);
  const sans = css("--sans") || "sans-serif", mono = css("--mono") || "monospace";
  const ink = css("--ink"), muted = css("--muted"), line = css("--line");

  ctx.fillStyle = css("--paper"); ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = css("--panel"); ctx.fillRect(16, 16, W - 32, H - 32);
  ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.strokeRect(16.5, 16.5, W - 33, H - 33);
  ctx.textBaseline = "alphabetic";

  // header
  ctx.fillStyle = muted; ctx.font = "600 13px " + mono;
  ctx.fillText("EDGE LAB  ·  IS THE EDGE REAL?", PAD, PAD + 12);
  ctx.textAlign = "right";
  ctx.fillText(new Date().toISOString().slice(0, 10), W - PAD, PAD + 12);
  ctx.textAlign = "left";

  // verdict + chip
  const vcol = $("vVerdict").style.color || ink;
  let fs = 44;
  ctx.font = "800 " + fs + "px " + sans;
  while (fs > 26 && ctx.measureText(txt("vVerdict")).width > 440) { fs -= 2; ctx.font = "800 " + fs + "px " + sans; }
  ctx.fillStyle = vcol;
  ctx.fillText(txt("vVerdict"), PAD, PAD + 70);
  const chip = txt("vChip");
  if (chip) {
    ctx.font = "700 13px " + mono;
    const cw = ctx.measureText(chip.toUpperCase()).width + 20;
    ctx.fillStyle = $("vChip").style.background || vcol;
    ctx.fillRect(PAD, PAD + 88, cw, 26);
    ctx.fillStyle = "#fff"; ctx.fillText(chip.toUpperCase(), PAD + 10, PAD + 106);
  }
  ctx.fillStyle = ink; ctx.font = "16px " + sans;
  let y = wrap(ctx, txt("vRead"), PAD, PAD + 146, 420, 22, 3);

  // the numbers
  y += 10;
  const rows: [string, string][] = [["Win rate, decided", "vWR"], ["Expectancy", "vEV"], ["Profit factor", "vPF"], ["Sample", "vN"]];
  for (const [k, id] of rows) {
    const [v, sub] = valSub(id);
    ctx.strokeStyle = line; ctx.beginPath(); ctx.moveTo(PAD, y + 0.5); ctx.lineTo(PAD + 420, y + 0.5); ctx.stroke();
    ctx.fillStyle = muted; ctx.font = "15px " + sans; ctx.fillText(k, PAD, y + 32);
    ctx.textAlign = "right";
    ctx.fillStyle = getComputedStyle($(id)).color || ink; ctx.font = "700 17px " + mono; ctx.fillText(v, PAD + 420, y + (sub ? 26 : 32));
    if (sub) { ctx.fillStyle = muted; ctx.font = "12px " + mono; ctx.fillText(sub.length > 40 ? sub.slice(0, 39) + "…" : sub, PAD + 420, y + 43); }
    ctx.textAlign = "left";
    y += 52;
  }
  ctx.strokeStyle = line; ctx.beginPath(); ctx.moveTo(PAD, y + 0.5); ctx.lineTo(PAD + 420, y + 0.5); ctx.stroke();
  ctx.fillStyle = muted; ctx.font = "13px " + sans;
  wrap(ctx, "Data: " + txt("sbSum"), PAD, y + 26, 420, 18, 2);

  // charts, right column
  const cx = PAD + 470, cw2 = W - PAD - cx;
  ctx.fillStyle = muted; ctx.font = "600 12px " + mono;
  ctx.fillText("WHERE THE TRUE EXPECTANCY COULD BE", cx, PAD + 40);
  ctx.fillText("DRAWDOWN TO PLAN FOR", cx, PAD + 318);
  drawCharts(ctx, [["cBell", cx, PAD + 52, cw2], ["cDD", cx, PAD + 330, cw2]]);

  // footer
  ctx.fillStyle = muted; ctx.font = "12px " + mono;
  ctx.fillText("github.com/jiifx/edge-lab", PAD, H - PAD + 6);
  ctx.textAlign = "right"; ctx.fillText("Not financial advice", W - PAD, H - PAD + 6); ctx.textAlign = "left";
  return cv;
}

export function saveReport() {
  // while Validate is still computing, the verdict is a loading bar and the
  // drawdown chart still shows the PREVIOUS edge - an image of that would pair
  // one edge's numbers with another's chart
  if (!txt("vVerdict") || /Simulating/.test($("ddLadder").textContent || "")) {
    toast("Still calculating. Try again in a moment.");
    return;
  }
  let url: string;
  try { url = buildReport().toDataURL("image/png"); } catch { toast("Could not draw the report in this environment."); return; }
  const name = "edge-lab-report-" + new Date().toISOString().slice(0, 10) + ".png";
  if (TAURI) {
    TAURI("export_report", { data: url.split(",")[1] })
      .then((p) => toast("Report saved: " + String(p)))
      .catch((e: unknown) => toast("Could not save the report: " + String(e)));
    return;
  }
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  toast("Report downloaded.");
}
