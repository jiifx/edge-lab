// The colour schemes, held to the standard the original two already met.
//
// Colour in this app is not decoration. The survival band under the Funded
// chart, the go/caution/stop verdict text on every tile, the accent line on a
// gate row - those ARE the readout, and a "safe" band you cannot tell from a
// "deadly" one is a wrong answer rendered confidently. With one light theme and
// one dark one that could be held by eye; with six choices it cannot, and the
// two numbers already written into index.html's own comments (bands >= 20 dE
// apart, >= 17 from the panel) were measured once by hand and never re-checked.
//
// So: every threshold below is the MINIMUM the shipped `light` and `dark`
// palettes already scored, rounded down. This suite cannot make the app prettier
// - it can only stop a new palette, or an edit to an old one, from being worse
// than what was there before. If a threshold ever has to be lowered to make a
// theme pass, the theme is wrong, not the threshold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const css = readFileSync(join(root, "index.html"), "utf8");

// ---- colour maths ----
const hex = (h) => {
  const s = h.replace("#", "").trim();
  const f = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
};
const lin = (c) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
const lum = (h) => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
// WCAG 2.x relative-luminance contrast ratio
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// CIE Lab (D65) + dE76 - the same measure index.html's band comment cites, so
// the numbers in this file and the numbers in that comment mean the same thing
function lab(h) {
  const [r, g, b] = hex(h).map(lin);
  const X = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const Z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
const dE = (a, b) => {
  const p = lab(a), q = lab(b);
  return Math.sqrt((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2);
};

// ---- the palettes, read out of the stylesheet itself ----
function palettes(src) {
  const out = {};
  const re = /:root\[data-theme="([a-z-]+)"\]\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(src))) {
    const vars = {};
    m[2].replace(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g, (_, k, v) => { vars[k] = v.trim(); return ""; });
    out[m[1]] = vars;
  }
  return out;
}
const T = palettes(css);
const NAMES = Object.keys(T);

// Every token a palette must carry. A theme that inherits half its colours from
// whatever was set last is how a chart ends up drawn in one palette's greens on
// another palette's paper - the failure is invisible in a screenshot of either
// theme on its own, and obvious the moment you switch.
const REQUIRED = [
  "--paper", "--panel", "--panel-2", "--ink", "--muted", "--line", "--line-strong",
  "--go", "--go-bg", "--go-ink", "--caution", "--caution-bg", "--caution-ink",
  "--stop", "--stop-bg", "--stop-ink", "--band-go", "--band-mid", "--band-stop",
  "--on-accent", "--grid", "--shadow",
];

test("every named theme exists and carries the complete token set", () => {
  for (const want of ["light", "dark", "carbon", "midnight", "parchment"]) {
    assert.ok(T[want], "missing palette: " + want);
  }
  for (const n of NAMES) {
    const missing = REQUIRED.filter((k) => !T[n][k]);
    assert.deepEqual(missing, [], n + " is missing " + missing.join(", "));
    assert.ok(/color-scheme:\s*(light|dark)\b/.test(css.split(':root[data-theme="' + n + '"]')[1].slice(0, 400)),
      n + " must declare color-scheme, or native date pickers and scrollbars open in the wrong chrome");
  }
});

// The one palette-shaped bug that ships looking fine: a swatch in the picker
// that no longer matches the palette it advertises. The swatch classes are plain
// CSS (they must be - a CSP nonce makes inline style attributes inert), so they
// can be checked against the palette by name.
test("the picker swatches show the palette they name", () => {
  for (const n of NAMES) {
    const m = css.match(new RegExp("\\.sw-" + n + " \\.a\\{background:(#[0-9A-Fa-f]{6});\\}[^]*?\\.sw-" + n + " \\.b\\{background:(#[0-9A-Fa-f]{6});\\}[^]*?\\.sw-" + n + " \\.c\\{background:(#[0-9A-Fa-f]{6});\\}"));
    assert.ok(m, "no swatch for " + n);
    assert.equal(m[1].toUpperCase(), T[n]["--paper"].toUpperCase(), n + " swatch paper");
    assert.equal(m[2].toUpperCase(), T[n]["--panel-2"].toUpperCase(), n + " swatch panel");
    assert.equal(m[3].toUpperCase(), T[n]["--go"].toUpperCase(), n + " swatch accent");
  }
});

// ---- text has to be readable on every surface it lands on ----
const atLeast = (label, min, fn) => test(label, () => {
  for (const n of NAMES) {
    const got = fn(T[n]);
    assert.ok(got >= min, n + ": " + label + " is " + got.toFixed(2) + ", needs >= " + min);
  }
});

atLeast("body text on the page background", 12, (v) => contrast(v["--ink"], v["--paper"]));
atLeast("body text on a panel", 12, (v) => contrast(v["--ink"], v["--panel"]));
atLeast("body text on an inset panel", 12, (v) => contrast(v["--ink"], v["--panel-2"]));
// --muted carries sub-lines, axis labels and half the explanatory copy, at 10-12px
atLeast("muted text on a panel", 5, (v) => contrast(v["--muted"], v["--panel"]));
atLeast("muted text on an inset panel", 5, (v) => contrast(v["--muted"], v["--panel-2"]));
// the verdict colours, which is what a trader actually reads off a tile
atLeast("go text on a panel", 5.5, (v) => contrast(v["--go-ink"], v["--panel"]));
atLeast("caution text on a panel", 5.5, (v) => contrast(v["--caution-ink"], v["--panel"]));
atLeast("stop text on a panel", 5.5, (v) => contrast(v["--stop-ink"], v["--panel"]));
// ...and on their own tints, where the R pills and tag chips put them
atLeast("go text on its tint", 5, (v) => contrast(v["--go-ink"], v["--go-bg"]));
atLeast("caution text on its tint", 5, (v) => contrast(v["--caution-ink"], v["--caution-bg"]));
atLeast("stop text on its tint", 5, (v) => contrast(v["--stop-ink"], v["--stop-bg"]));
// pressed tabs and the toast invert: paper on ink
atLeast("inverted text (pressed tab, toast)", 12, (v) => contrast(v["--paper"], v["--ink"]));
// --on-accent exists because this pair used to be a hard-coded #fff, which
// measured 2.58:1 on the dark theme's green
atLeast("chip / primary-button text on green", 4.5, (v) => contrast(v["--on-accent"], v["--go"]));
atLeast("chip / primary-button text on red", 4.5, (v) => contrast(v["--on-accent"], v["--stop"]));

// ---- the chart bands: the reason this file exists ----
// The comment in index.html states the rule: separated to dE >= 20 from each
// other and >= 17 from the panel (measured at >= 15 on the shipped pair), with
// the --ink curve drawn over them still above 9:1.
atLeast("safe vs caution band separation", 20, (v) => dE(v["--band-go"], v["--band-mid"]));
atLeast("caution vs deadly band separation", 20, (v) => dE(v["--band-mid"], v["--band-stop"]));
atLeast("safe vs deadly band separation", 20, (v) => dE(v["--band-go"], v["--band-stop"]));
atLeast("safe band against the canvas", 15, (v) => dE(v["--band-go"], v["--panel-2"]));
atLeast("caution band against the canvas", 15, (v) => dE(v["--band-mid"], v["--panel-2"]));
atLeast("deadly band against the canvas", 15, (v) => dE(v["--band-stop"], v["--panel-2"]));
atLeast("the profit curve over the safe band", 9, (v) => contrast(v["--ink"], v["--band-go"]));
atLeast("the profit curve over the caution band", 9, (v) => contrast(v["--ink"], v["--band-mid"]));
atLeast("the profit curve over the deadly band", 9, (v) => contrast(v["--ink"], v["--band-stop"]));

// ---- the three verdict hues must stay three hues ----
// go/caution/stop appear side by side as chart strokes, meter fills and coloured
// numbers in the same table. If two of them converge the reader is not told the
// colours mean less - the screen just quietly stops distinguishing two answers.
atLeast("green vs red are distinct hues", 30, (v) => dE(v["--go"], v["--stop"]));
atLeast("green vs amber are distinct hues", 30, (v) => dE(v["--go"], v["--caution"]));
atLeast("amber vs red are distinct hues", 30, (v) => dE(v["--caution"], v["--stop"]));
atLeast("go vs stop TEXT are distinct", 25, (v) => dE(v["--go-ink"], v["--stop-ink"]));
atLeast("go vs caution TEXT are distinct", 25, (v) => dE(v["--go-ink"], v["--caution-ink"]));
atLeast("caution vs stop TEXT are distinct", 25, (v) => dE(v["--caution-ink"], v["--stop-ink"]));

// ---- structure: this app is drawn almost entirely in borders ----
atLeast("a strong border against its panel", 20, (v) => dE(v["--line-strong"], v["--panel"]));
atLeast("a hairline border against its panel", 10, (v) => dE(v["--line"], v["--panel"]));
atLeast("an accent stroke against its panel", 40, (v) => dE(v["--go"], v["--panel"]));

// A palette is only honest if it commits: a "dark" theme whose panel is lighter
// than its paper, or a light one the other way round, inverts every shadow and
// border relationship the layout was drawn against.
test("panels sit above the page in every palette, never below it", () => {
  for (const n of NAMES) {
    const v = T[n];
    const dark = lum(v["--paper"]) < 0.2;
    assert.ok(lum(v["--panel"]) > lum(v["--paper"]),
      n + ": --panel must be lighter than --paper. The layout draws every card as a lifted surface; " +
      "inverting that relationship makes the whole page read inside-out even though nothing overlaps.");
    assert.equal(lum(v["--ink"]) > lum(v["--paper"]), dark,
      n + ": --ink contrasts the wrong way round against --paper");
  }
});
