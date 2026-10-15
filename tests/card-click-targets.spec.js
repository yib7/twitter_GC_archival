const { test, expect } = require("@playwright/test");
const { bootViewer, msgs, conv } = require("./_viewer-fixture.js");

// clickable result cards (Search results, bookmark cards) handled click
// and Enter/Space on the whole card, so their children's own interactions
// were hijacked: clicking a link opened the tab AND jumped the app to the
// Timeline; clicking an avatar jumped AND opened the profile; Enter on a
// focused link was preventDefault'ed (the link never opened) and jumped
// instead. The card now ignores events that come from its interactive
// children, and Enter/Space act only when the card itself is focused.
const URL_ = "https://example.test/page";
const A = msgs("a", 4, { x: (k) => (k === 1 ? "see " + URL_ + " now" : "plain " + k) });
const B = msgs("b", 3, { x: (k) => (k === 0 ? "other chat " + URL_ : "b " + k), t0: Date.parse("2024-05-01T12:00:00Z") });
const DATA = { conversations: [conv("A", "Alpha", A), conv("B", "Beta", B)] };

async function setup(page, ls) {
  // never let a test reach the network: the fake link target is answered locally
  await page.context().route("https://example.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<title>ok</title>" }));
  await bootViewer(page, DATA, { ls });
}
const view = (page) => page.evaluate(() => document.querySelector(".nav-item[aria-current=page]").dataset.view);

test("clicking a link inside a search result opens it without jumping to the Timeline", async ({ page }) => {
  await setup(page);
  const link = page.locator('#s-list .msg a[href="' + URL_ + '"]');
  const popup = page.waitForEvent("popup");
  await link.click();
  await (await popup).close();
  expect(await view(page)).toBe("search");
});

test("clicking an avatar in a search result opens the profile without jumping", async ({ page }) => {
  await setup(page);
  await page.locator("#s-list .msg .av").first().click();
  await expect(page.locator(".profile-modal")).toBeVisible();
  expect(await view(page)).toBe("search");
});

test("Enter on a focused link opens the link; Enter on the card itself still jumps", async ({ page }) => {
  await setup(page);
  const link = page.locator('#s-list .msg a[href="' + URL_ + '"]');
  await link.focus();
  const popup = page.waitForEvent("popup", { timeout: 5000 });
  await page.keyboard.press("Enter");
  await (await popup).close();
  expect(await view(page)).toBe("search");
  // the card itself keeps its keyboard activation
  await page.locator("#s-list .msg").first().focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => view(page)).toBe("timeline");
});

test("a bookmark card from another conversation does not hijack its link", async ({ page }) => {
  await setup(page, { "gca.settings": JSON.stringify({ pins: ["b0"] }), "gca.lastView": "pins" });
  const link = page.locator('#view-pins .msg a[href="' + URL_ + '"]');
  await expect(link).toBeVisible();
  const popup = page.waitForEvent("popup");
  await link.click();
  await (await popup).close();
  expect(await view(page)).toBe("pins");
  await expect(page.locator("#brand-title")).toHaveText("Alpha");
});
