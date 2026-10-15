// WCAG contrast helpers in src/shared-core.js. The viewer uses
// them to derive --on-accent / --accent-fill / --accent-text from the
// user-selectable accent and to keep user-picked person colours readable in
// every theme, so the maths is pinned here independently of the DOM.
require("./_real-data-guard.js");
const test = require("node:test");
const assert = require("node:assert");
const { contrastRatio, relLuminance, readableOn, accentTokens } = require("../src/shared-core.js");

const ACCENTS = ["#1d9bf0", "#3b82f6", "#2563eb", "#1d4ed8", "#0ea5e9", "#38bdf8", "#06b6d4", "#0891b2", "#6366f1", "#818cf8", "#60a5fa"];
const THEME_BGS = { lightsout: ["#000000", "#16181c"], dim: ["#15202b", "#1e2732"], light: ["#ffffff", "#f7f9f9"] };

test("relLuminance / contrastRatio match the WCAG 2.x reference values", () => {
  assert.strictEqual(relLuminance("#000000"), 0);
  assert.strictEqual(relLuminance("#ffffff"), 1);
  assert.strictEqual(+contrastRatio("#ffffff", "#000000").toFixed(2), 21);
  assert.strictEqual(+contrastRatio("#000", "#fff").toFixed(2), 21);           // shorthand + order-independent
  assert.strictEqual(+contrastRatio("#1d9bf0", "#ffffff").toFixed(2), 3.0);     // X blue on white (the audit's 3.0:1)
  assert.strictEqual(+contrastRatio("#777777", "#ffffff").toFixed(2), 4.48);
  assert.strictEqual(+contrastRatio("rgb(119, 119, 119)", "#fff").toFixed(2), 4.48);   // computed-style strings too
});

test("readableOn keeps a colour that already passes and nudges one that does not", () => {
  assert.strictEqual(readableOn("#e7e9ea", ["#000000"], 4.5), "#e7e9ea");
  for (const [bgs, c] of [[THEME_BGS.light, "#eab308"], [THEME_BGS.lightsout, "#1e3a8a"], [THEME_BGS.dim, "#3b3b3b"], [THEME_BGS.light, "#ffffff"]]) {
    const out = readableOn(c, bgs, 4.5);
    for (const bg of bgs) assert.ok(contrastRatio(out, bg) >= 4.5, `${c} -> ${out} on ${bg}: ${contrastRatio(out, bg).toFixed(2)}`);
  }
  // dark backgrounds lighten, light backgrounds darken (hue kept, not flipped to b/w)
  assert.ok(relLuminance(readableOn("#1e3a8a", THEME_BGS.lightsout, 4.5)) > relLuminance("#1e3a8a"));
  assert.ok(relLuminance(readableOn("#eab308", THEME_BGS.light, 4.5)) < relLuminance("#eab308"));
});

test("accentTokens: text on a filled accent reaches 4.5:1 for every preset accent, fill stays close", () => {
  for (const a of ACCENTS) {
    for (const t of Object.keys(THEME_BGS)) {
      const k = accentTokens(a, THEME_BGS[t]);
      assert.ok(["#ffffff", "#0f1419"].includes(k.onAccent), a + " onAccent " + k.onAccent);
      assert.ok(contrastRatio(k.onAccent, k.fill) >= 4.5, `${a}/${t}: on ${k.onAccent} vs fill ${k.fill} = ${contrastRatio(k.onAccent, k.fill).toFixed(2)}`);
      assert.ok(contrastRatio(k.onAccent, k.gradEnd) >= 4.5, `${a}/${t}: gradient end ${k.gradEnd}`);
      assert.ok(contrastRatio(k.fill, a) < 1.25, `${a}: fill ${k.fill} drifted too far`);
      for (const bg of THEME_BGS[t]) assert.ok(contrastRatio(k.text, bg) >= 4.5, `${a}/${t}: accent text ${k.text} on ${bg}`);
      // the focus ring / UI accent is a 3:1 non-text colour on the page
      assert.ok(contrastRatio(k.ui, THEME_BGS[t][0]) >= 3, `${a}/${t}: ui ${k.ui}`);
    }
  }
  // X blue itself: white text only reaches 3.0:1, so the derived text is near-black
  assert.strictEqual(accentTokens("#1d9bf0", THEME_BGS.lightsout).onAccent, "#0f1419");
  // a deep blue keeps white text and its own fill
  const deep = accentTokens("#1d4ed8", THEME_BGS.lightsout);
  assert.strictEqual(deep.onAccent, "#ffffff");
  assert.strictEqual(deep.fill, "#1d4ed8");
});
