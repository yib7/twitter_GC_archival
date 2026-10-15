// Rendered-text contrast audit shared by a11y-sp5.spec and mobile-390.spec.
// Every visible text run is checked against the colour actually behind it:
// ancestor backgrounds are composited and element opacity is applied. A
// gradient background is checked against EACH of its colour stops (the worst
// one counts), so own-message bubbles, avatar initials, the Stats hero and
// primary buttons are covered too. Only url() images (photos, avatars with a
// picture) can't be computed from styles and are skipped. Gradient text
// (background-clip: text) uses its stops as the ink.
// Normal text >= 4.5:1, large text (>= 24px, or >= 18.66px bold) >= 3:1.
async function contrastFailures(page, root, skip) {
  return page.evaluate(([sel, skipSel]) => {
    const parse = (c) => {
      const m = c.match(/[\d.]+(e-?\d+)?/g); if (!m) return null;
      const a = m.map(Number), k = /^color\(srgb/.test(c) ? 255 : 1; // color-mix() computes to color(srgb 0–1)
      return { r: a[0] * k, g: a[1] * k, b: a[2] * k, a: a.length > 3 ? a[3] : 1 };
    };
    const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const lum = (c) => [c.r, c.g, c.b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce((s, v, k) => s + v * [0.2126, 0.7152, 0.0722][k], 0);
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    // Candidate backgrounds behind e: one colour, or one per gradient stop.
    const bgsOf = (e) => {
      const layers = [];
      let base = [parse(getComputedStyle(document.body).backgroundColor)];
      for (let n = e; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        const c = parse(cs.backgroundColor);
        if (cs.backgroundImage !== "none") {
          if (/url\(/.test(cs.backgroundImage)) return null;
          const stops = (cs.backgroundImage.match(/(rgba?\([^)]*\)|color\([^)]*\))/g) || []).map(parse);
          if (stops.length) {
            const under = c && c.a > 0 ? over(c, base[0]) : base[0];
            base = stops.map((s) => over(s, under));
            if (stops.every((s) => s.a >= 1)) break;
            continue;
          }
        }
        if (c && c.a > 0) { layers.push(c); if (c.a >= 1) { base = [{ ...c, a: 1 }]; layers.pop(); break; } }
      }
      return base.map((b) => { let acc = b; for (let k = layers.length - 1; k >= 0; k--) acc = over(layers[k], acc); return acc; });
    };
    const out = [];
    const r0 = document.querySelector(sel);
    if (!r0) return out;
    for (const e of r0.querySelectorAll("*")) {
      if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      if (e.closest("[aria-hidden=true], svg, canvas, button:disabled" + (skipSel ? ", " + skipSel : ""))) continue;
      const cs = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height || cs.visibility === "hidden") continue;
      let op = 1; for (let n = e; n; n = n.parentElement) op *= Number(getComputedStyle(n).opacity);
      if (op < 0.05) continue;
      const px = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700;
      const need = px >= 24 || (bold && px >= 18.66) ? 3 : 4.5;
      // gradient text (background-clip: text, transparent colour): the
      // gradient stops are the ink, the parent's background is behind it
      const clipText = /text/.test(cs.webkitBackgroundClip || "") || /text/.test(cs.backgroundClip || "");
      const inks = clipText ? (cs.backgroundImage.match(/(rgba?\([^)]*\)|color\([^)]*\))/g) || []).map(parse) : [parse(cs.color)];
      const bgs = bgsOf(clipText ? e.parentElement : e); if (!bgs || !inks.length) continue;
      let cr = Infinity;
      for (const f0 of inks) for (const bg of bgs) cr = Math.min(cr, ratio(over({ r: f0.r, g: f0.g, b: f0.b, a: f0.a * op }, bg), bg));
      if (cr < need) out.push((e.parentElement.className ? String(e.parentElement.className).split(" ")[0] + ">" : "") + e.tagName.toLowerCase() + "." + String(e.className).trim().split(/\s+/).slice(0, 2).join(".") + " “" + e.textContent.trim().slice(0, 18) + "” " + cr.toFixed(2));
    }
    return out;
  }, [root, skip || ""]);
}
module.exports = { contrastFailures };
