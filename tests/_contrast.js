// Rendered-text contrast audit shared by a11y-keyboard.spec and mobile-390.spec.
// Every visible text run is checked against the colour actually behind it:
// ancestor backgrounds are composited and element opacity is applied. A
// gradient background is checked against EACH of its colour stops (the worst
// one counts), so own-message bubbles, avatar initials, the Stats hero and
// primary buttons are covered too. Only url() images (photos, avatars with a
// picture) can't be computed from styles and are skipped. A ::before/::after
// that covers its element (inset 0: a vignette, a scrim) is one more layer of
// that element's background. Gradient text
// (background-clip: text) uses its stops as the ink. Generated text (a
// ::before / ::after whose content is a string, counter() or attr(), e.g. a
// numbered step dot) is checked too, with its own colour over its own
// background laid on its element's.
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
    // Candidate backgrounds behind e. The paint stack is collected top-down:
    // per element its background-image gradients (first listed = on top),
    // then its background-color; the walk stops at the first fully opaque
    // layer (or falls through to <body>). It is then composited bottom-up,
    // every stop of a gradient being one alternative, so a translucent
    // gradient (e.g. a radial glow fading to transparent) is laid OVER the
    // ancestors under it instead of being replaced by them.
    const GRAD = /(?:repeating-)?(?:linear|radial|conic)-gradient\((?:[^()]|\([^()]*\))*\)/g;
    const COLOR = /(rgba?\([^)]*\)|color\([^)]*\))/g;
    // A radial gradient with an explicit "W H [at X Y]" ellipse (px or %) is position-
    // aware: only the colours it actually paints over the text's rect count
    // (nearest and farthest point, plus any stop in between). Other gradients
    // count every stop.
    const splitTop = (str) => { const out = []; let depth = 0, cur = ""; for (const ch of str) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && !depth) { out.push(cur.trim()); cur = ""; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
    const mixC = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t });
    const radialStops = (g, box, text) => {
      const m = /^radial-gradient\(\s*([\d.]+)(px|%)\s+([\d.]+)(px|%)(?:\s+at\s+(-?[\d.]+)(%|px)\s+(-?[\d.]+)(%|px))?\s*,(.*)\)$/.exec(g);
      if (!m || !text) return null;
      const rx = m[2] === "%" ? box.width * m[1] / 100 : +m[1], ry = m[4] === "%" ? box.height * m[3] / 100 : +m[3];
      if (m[5] == null) { m[5] = m[7] = "50"; m[6] = m[8] = "%"; }   // computed style drops a centred "at 50% 50%"
      const cx = box.left + (m[6] === "%" ? box.width * m[5] / 100 : +m[5]);
      const cy = box.top + (m[8] === "%" ? box.height * m[7] / 100 : +m[7]);
      const parts = splitTop(m[9]).map((p) => { const c = p.match(COLOR); const pos = p.replace(c ? c[0] : "", "").trim(); return { c: c && parse(c[0]), at: /%$/.test(pos) ? parseFloat(pos) / 100 : null }; }).filter((x) => x.c);
      if (parts.length < 2) return null;
      parts.forEach((x, k) => { if (x.at == null) x.at = k === 0 ? 0 : k === parts.length - 1 ? 1 : (parts[k - 1].at + 1) / 2; });
      const at = (d) => {
        if (d <= parts[0].at) return parts[0].c;
        for (let k = 1; k < parts.length; k++) if (d <= parts[k].at) return mixC(parts[k - 1].c, parts[k].c, (d - parts[k - 1].at) / Math.max(1e-6, parts[k].at - parts[k - 1].at));
        return parts[parts.length - 1].c;
      };
      const nd = (x, y) => Math.hypot((x - cx) / rx, (y - cy) / ry);
      const near = nd(Math.min(Math.max(cx, text.left), text.right), Math.min(Math.max(cy, text.top), text.bottom));
      const far = Math.max(...[[text.left, text.top], [text.right, text.top], [text.left, text.bottom], [text.right, text.bottom]].map(([x, y]) => nd(x, y)));
      return [at(near), at(far)].concat(parts.filter((x) => x.at > near && x.at < far).map((x) => x.c));
    };
    const coverPseudos = (n) => ["::after", "::before"].map((p) => getComputedStyle(n, p)).filter((ps) =>
      ps.content && ps.content !== "none" && ps.content !== "normal" && /absolute|fixed/.test(ps.position) &&
      [ps.top, ps.right, ps.bottom, ps.left].every((v) => v === "0px"));
    // `own` (optional): the computed style of a text-bearing ::before /
    // ::after of e, painted above e's own layers.
    const bgsOf = (e, text, own) => {
      const stack = [];
      let floor = [parse(getComputedStyle(document.body).backgroundColor)];
      walk: for (let n = e; n; n = n.parentElement) {
        // an absolutely positioned ::after / ::before that covers
        // the element (inset 0 — a vignette, a scrim) paints over the
        // element's own background and under its content, so it is the top
        // layer of this element (::after above ::before).
        const box = n.getBoundingClientRect();
        for (const cs of (n === e && own ? [own] : []).concat(coverPseudos(n), [getComputedStyle(n)])) {
          if (cs.backgroundImage !== "none") {
            if (/url\(/.test(cs.backgroundImage)) return null;
            for (const g of cs.backgroundImage.match(GRAD) || []) {
              const stops = radialStops(g, box, text) || (g.match(COLOR) || []).map(parse);
              if (!stops.length) continue;
              if (stops.every((st) => st.a >= 1)) { floor = stops; break walk; }
              stack.push(stops);
            }
          }
          const c = parse(cs.backgroundColor);
          if (c && c.a >= 1) { floor = [c]; break walk; }
          if (c && c.a > 0) stack.push([c]);
        }
      }
      let cands = floor;
      for (let k = stack.length - 1; k >= 0; k--) {
        const next = [];
        for (const under of cands) for (const st of stack[k]) next.push(over(st, under));
        const seen = new Set();
        cands = next.filter((x) => { const key = [x.r, x.g, x.b].map(Math.round).join(","); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 64);
      }
      return cands;
    };
    const out = [];
    const r0 = document.querySelector(sel);
    if (!r0) return out;
    const skipped = (e) => e.closest("[aria-hidden=true], svg, canvas, button:disabled" + (skipSel ? ", " + skipSel : ""));
    const opacityOf = (e) => { let op = 1; for (let n = e; n; n = n.parentElement) op *= Number(getComputedStyle(n).opacity); return op; };
    const needOf = (cs) => { const px = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700; return px >= 24 || (bold && px >= 18.66) ? 3 : 4.5; };
    const worst = (inks, bgs, op) => {
      let cr = Infinity;
      for (const f0 of inks) for (const bg of bgs) cr = Math.min(cr, ratio(over({ r: f0.r, g: f0.g, b: f0.b, a: f0.a * op }, bg), bg));
      return cr;
    };
    const tag = (e) => e.tagName.toLowerCase() + "." + String(e.className).trim().split(/\s+/).slice(0, 2).join(".");
    // The text a ::before / ::after generates: quoted strings, counter() /
    // counters() and attr(). content: "" (a decorative layer, a connector
    // line, a scrim) generates none. A counter is reported by its name.
    const generated = (e, content) => {
      if (!content || content === "none" || content === "normal") return "";
      let t = "";
      const TOK = /"((?:[^"\\]|\\.)*)"|(counters?\([^)]*\))|attr\(([^)]*)\)/g;
      for (let m; (m = TOK.exec(content));) {
        if (m[1] != null) t += m[1].replace(/\\(.)/g, "$1");
        else if (m[2] != null) t += m[2];
        else t += e.getAttribute(m[3].trim()) || "";
      }
      return t.trim();
    };
    // generated text: its own colour and font, over its own background
    // layers laid on top of its element's
    for (const e of [r0].concat([...r0.querySelectorAll("*")])) {
      if (skipped(e)) continue;
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      for (const p of ["::before", "::after"]) {
        const ps = getComputedStyle(e, p);
        const t = generated(e, ps.content);
        if (!t || ps.display === "none" || ps.visibility === "hidden") continue;
        const op = opacityOf(e) * Number(ps.opacity);
        if (op < 0.05) continue;
        const bgs = bgsOf(e, r, ps); if (!bgs) continue;
        const cr = worst([parse(ps.color)], bgs, op);
        if (cr < needOf(ps)) out.push(tag(e) + p + " “" + t.slice(0, 18) + "” " + cr.toFixed(2));
      }
    }
    for (const e of r0.querySelectorAll("*")) {
      if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      if (skipped(e)) continue;
      const cs = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height || cs.visibility === "hidden") continue;
      const op = opacityOf(e);
      if (op < 0.05) continue;
      // gradient text (background-clip: text, transparent colour): the
      // gradient stops are the ink, the parent's background is behind it
      const clipText = /text/.test(cs.webkitBackgroundClip || "") || /text/.test(cs.backgroundClip || "");
      const inks = clipText ? (cs.backgroundImage.match(/(rgba?\([^)]*\)|color\([^)]*\))/g) || []).map(parse) : [parse(cs.color)];
      const bgs = bgsOf(clipText ? e.parentElement : e, r); if (!bgs || !inks.length) continue;
      const cr = worst(inks, bgs, op);
      if (cr < needOf(cs)) out.push((e.parentElement.className ? String(e.parentElement.className).split(" ")[0] + ">" : "") + tag(e) + " “" + e.textContent.trim().slice(0, 18) + "” " + cr.toFixed(2));
    }
    return out;
  }, [root, skip || ""]);
}
module.exports = { contrastFailures };
