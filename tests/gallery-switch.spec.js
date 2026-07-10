const { test, expect } = require("@playwright/test");

// P1-1: renderGallery() only rebuilds when #view-gallery is empty, and
// resetDerived() never cleared it on a conversation switch — so the gallery
// stayed pinned to whichever group it was first opened on. The gallery must
// track the active conversation in both directions (A → B → A), including
// recovering after a visit to an all-ignored (N === 0) group.
const DATA = {
  __sample: true,
  conversations: [
    { id: "A", type: "group", title: "Alpha", participants: ["u1"], count: 3,
      msgs: [
        { i: "a1", s: "u1", t: Date.parse("2024-01-01T10:00:00Z"), x: "alpha text" },
        { i: "a2", s: "u1", t: Date.parse("2024-01-02T10:00:00Z"), x: "alpha pic one", m: "sample_media/alpha_1.png", k: "img" },
        { i: "a3", s: "u1", t: Date.parse("2024-01-03T10:00:00Z"), x: "alpha pic two", m: "sample_media/alpha_2.png", k: "img" },
      ], events: [] },
    { id: "B", type: "group", title: "Beta", participants: ["u2"], count: 4,
      msgs: [
        { i: "b1", s: "u2", t: Date.parse("2024-02-01T10:00:00Z"), x: "beta text" },
        { i: "b2", s: "u2", t: Date.parse("2024-02-02T10:00:00Z"), x: "beta pic one", m: "sample_media/beta_1.png", k: "img" },
        { i: "b3", s: "u2", t: Date.parse("2024-02-03T10:00:00Z"), x: "beta pic two", m: "sample_media/beta_2.png", k: "img" },
        { i: "b4", s: "u2", t: Date.parse("2024-02-04T10:00:00Z"), x: "beta pic three", m: "sample_media/beta_3.png", k: "img" },
      ], events: [] },
  ],
};

async function boot(page, { savedConv, localJs = "" } = {}) {
  await page.addInitScript((saved) => {
    localStorage.setItem("gca.onboarded", "1");
    localStorage.removeItem("gca.lastView");
    if (saved) localStorage.setItem("gca.conv", saved);
  }, savedConv);
  await page.route("**/data.sample.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.CHAT_DATA = " + JSON.stringify(DATA) + ";" }));
  await page.route("**/data.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/local.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: localJs }));
  await page.goto("/");
  await expect(page.locator(".msg").first()).toBeVisible();
}

// img.src is assigned the raw m.m path, so the src *attribute* keeps the
// relative "sample_media/…" form — assert on filenames, order-agnostically.
async function expectGallerySrcs(page, filenames) {
  const imgs = page.locator("#gal-list .gcell img");
  await expect(imgs).toHaveCount(filenames.length);
  const srcs = await imgs.evaluateAll((els) => els.map((e) => e.getAttribute("src")));
  expect(srcs.map((s) => s.split("/").pop()).sort()).toEqual([...filenames].sort());
}

test("gallery follows the active conversation across switches (A → B → A)", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));

  await boot(page, { savedConv: "A" });
  await page.locator('.nav-item[data-view="gallery"]').click();
  await expectGallerySrcs(page, ["alpha_1.png", "alpha_2.png"]);

  // Switch groups while Gallery is the active view — it must rebuild for Beta.
  await page.locator("#conv-select").selectOption("B");
  await expect(page.locator("#brand-title")).toHaveText("Beta");
  await expectGallerySrcs(page, ["beta_1.png", "beta_2.png", "beta_3.png"]);

  // And back again — no residue from either direction.
  await page.locator("#conv-select").selectOption("A");
  await expect(page.locator("#brand-title")).toHaveText("Alpha");
  await expectGallerySrcs(page, ["alpha_1.png", "alpha_2.png"]);

  expect(errors).toEqual([]);
});

test("gallery recovers after visiting an all-ignored group (N === 0 panel)", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));

  // Every sender in Alpha is ignored, so its gallery is the empty panel.
  await boot(page, { savedConv: "B", localJs: 'window.LOCAL_IGNORED_USERS = ["u1"];' });
  await page.locator('.nav-item[data-view="gallery"]').click();
  await expectGallerySrcs(page, ["beta_1.png", "beta_2.png", "beta_3.png"]);

  await page.locator("#conv-select").selectOption("A");
  await expect(page.locator("#view-gallery .empty")).toBeVisible();

  // Returning to Beta must replace the empty panel with Beta's media again.
  await page.locator("#conv-select").selectOption("B");
  await expectGallerySrcs(page, ["beta_1.png", "beta_2.png", "beta_3.png"]);

  expect(errors).toEqual([]);
});
