const { test, expect } = require("@playwright/test");

// X represents an arbitrary-emoji DM reaction with reactionKey:"emoji"
// and the real glyph in a separate field (build-core.js rawToRec now captures
// it as rec.r[i].e). Before this fix, every custom-emoji reaction collapsed
// into the same generic REACT.emoji ("💬") chip — this spec proves:
//   1. the captured glyph renders as its own distinct chip (not the generic 💬)
//   2. a glyph containing HTML special characters is ESCAPED — it must render
//      as inert text in the chip and its title, never as live markup.
const CLEAN = { i: "m1", s: "u1", t: Date.parse("2020-01-01T10:00:00Z"), x: "clean custom emoji",
  r: [{ k: "emoji", s: "u2", e: "🎉" }] };
// A crafted glyph carrying '<', '&', '"' — if it ever reaches innerHTML
// unescaped, this creates a live <img> that fires onerror.
const PAYLOAD = '<img src=x onerror=window.__pwned=1>&"';
const XSS = { i: "m2", s: "u2", t: Date.parse("2020-01-01T10:01:00Z"), x: "malicious custom emoji",
  r: [{ k: "emoji", s: "u1", e: PAYLOAD }] };

const DATA = {
  __sample: true,
  conversations: [
    { id: "G1", type: "group", title: "Reacts", participants: ["u1", "u2"], count: 2,
      msgs: [CLEAN, XSS], events: [] },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
  });
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(DATA) + ";" }));
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
});

test("a custom-emoji reaction renders its captured glyph, not the generic placeholder", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));

  await page.goto("/");
  await expect(page.locator(".bubble").first()).toBeVisible();

  const cleanReact = page.locator('.msg', { hasText: "clean custom emoji" }).locator(".react");
  await expect(cleanReact).toHaveCount(1);
  await expect(cleanReact).toContainText("🎉");
  // The generic placeholder must NOT be used for a captured custom glyph.
  expect(await cleanReact.innerText()).not.toContain("💬");
  await expect(cleanReact).toHaveAttribute("title", /🎉 — /);

  expect(errors).toEqual([]);
});

test("a custom-emoji glyph containing HTML special chars is escaped, never injected as markup", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  // No native dialog should ever appear (nothing here calls alert/confirm);
  // guard anyway so a stray dialog can't hang the test.
  page.on("dialog", (d) => d.dismiss());

  await page.goto("/");
  await expect(page.locator(".bubble").first()).toBeVisible();

  const xssReact = page.locator('.msg', { hasText: "malicious custom emoji" }).locator(".react");
  await expect(xssReact).toHaveCount(1);

  // The crafted glyph never executed and never became a live element.
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await xssReact.locator("img").count()).toBe(0);

  // It rendered as inert TEXT inside the chip (escaped entities decode back to
  // the original glyph when read as innerText).
  await expect(xssReact).toContainText(PAYLOAD);

  // The title is set via a JS property assignment (not parsed as markup), so
  // its attribute value carries the escaped form verbatim (literal "&lt;",
  // "&amp;" characters) rather than decoding back to "<" — it must never
  // contain a raw "<img", proving esc() ran on the glyph before it reached
  // the title too, per the brief's belt-and-suspenders requirement.
  const title = await xssReact.getAttribute("title");
  expect(title).not.toBeNull();
  expect(title).not.toContain("<img");
  expect(title).toContain("&lt;img");

  expect(errors).toEqual([]);
});
