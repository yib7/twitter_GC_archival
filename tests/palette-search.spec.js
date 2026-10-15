const { test, expect } = require("@playwright/test");
const { bootViewer, conv, msgs } = require("./_viewer-fixture.js");

// SP9 (UX-8): Ctrl/Cmd+K searches messages too — the top hits show inline
// (highlighted snippet, sender, date) after the commands, with "See all in
// Search" opening the Search view on the same query. Same engine as Search
// (operators included), debounced. The Timeline's "Search" button opens the
// Search view. The query never reaches the URL. Synthetic data only.
test.use({ timezoneId: "UTC" });

const T = Date.parse("2024-03-10T12:00:00Z");
const LIST = msgs("m", 12, {
  s: ["u1", "u2", "u3"],
  t0: T,
  x: (k) => (k % 3 === 2 ? "nothing to see " + k : "we ordered pizza number " + k + " and it was a very long night of talking about everything under the sun"),
});
const DATA = { conversations: [conv("A", "Alpha", LIST)] };
const NAMES = 'window.LOCAL_NAMES = {"u1":"Bob","u2":"Bella","u3":"Cy"};';
const open = async (page, q) => {
  await page.keyboard.press("Control+k");
  await expect(page.locator(".cmdk-input")).toBeFocused();
  await page.locator(".cmdk-input").fill(q);
};
const hits = (page) => page.locator(".cmdk-list .cmdk-row.cmdk-msg");
const seeAll = (page) => page.locator(".cmdk-list .cmdk-row.cmdk-seeall");

test("message hits show inline with a highlighted snippet, then See all in Search", async ({ page }) => {
  await bootViewer(page, DATA, { local: NAMES, ls: { "gca.lastView": "timeline" } });
  await open(page, "pizza");
  await expect(hits(page)).toHaveCount(5);
  await expect(page.locator(".cmdk-list .cmdk-group", { hasText: "Messages" })).toHaveCount(1);
  // newest first, with sender + date, the match marked
  await expect(hits(page).first()).toContainText("pizza number 10");
  await expect(hits(page).first()).toContainText("Bella");
  await expect(hits(page).first().locator("mark").first()).toHaveText("pizza");
  await expect(hits(page).first()).toHaveAttribute("role", "option");
  await expect(seeAll(page)).toContainText("See all in Search");
  await expect(seeAll(page)).toContainText("8 messages match");
  // See all opens Search on the same query (keyboard: walk down to it)
  const n = await page.locator(".cmdk-list [role=option]").count();
  for (let k = 0; k < n; k++) await page.keyboard.press("ArrowDown");
  await expect(page.locator("#" + await page.locator(".cmdk-input").getAttribute("aria-activedescendant"))).toHaveClass(/cmdk-seeall/);
  await page.keyboard.press("Enter");
  await expect(page.locator(".cmdk")).toHaveCount(0);
  await expect(page.locator('.nav-item[data-view="search"]')).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#s-input")).toHaveValue("pizza");
  await expect(page.locator("#s-input")).toBeFocused();
  await expect(page.locator("#s-meta")).toContainText("8 messages found");
  expect(page.url()).not.toContain("pizza");
});

test("a hit jumps to its message; operators work in the palette too", async ({ page }) => {
  await bootViewer(page, DATA, { local: NAMES });
  await open(page, "from:bella pizza");
  await expect(hits(page)).toHaveCount(4);
  for (const t of await hits(page).allTextContents()) expect(t).toContain("Bella");
  await hits(page).nth(1).click();
  await expect(page.locator('.nav-item[data-view="timeline"]')).toHaveAttribute("aria-current", "page");
  await expect(page.locator('#tl-list .msg.flash')).toContainText("pizza number 7");
});

test("no hit: one row searches the messages (close matches) in Search", async ({ page }) => {
  await bootViewer(page, DATA, { local: NAMES });
  await open(page, "pizzza");
  await expect(seeAll(page)).toContainText("Search messages for “pizzza”");
  await expect(hits(page)).toHaveCount(0);
  await expect(page.locator(".cmdk-list [role=option]")).toHaveCount(1);
  await expect(page.locator("#sr-status")).toContainText("No matches");
  await page.keyboard.press("Enter");
  await expect(page.locator("#s-input")).toHaveValue("pizzza");
  await expect(page.locator("#s-meta")).toContainText("close match");
});

test("commands still come first and short queries don't search messages", async ({ page }) => {
  await bootViewer(page, DATA, { local: NAMES });
  await open(page, "p");
  await expect(page.locator(".cmdk-list .cmdk-row").first()).not.toHaveClass(/cmdk-msg/);
  await page.locator(".cmdk-input").fill("pinned");
  await expect(page.locator(".cmdk-list .cmdk-row").first()).toContainText("Pinned messages");
});

test("the Timeline's Search button opens the Search view with the box focused", async ({ page }) => {
  await bootViewer(page, DATA, { local: NAMES, ls: { "gca.lastView": "timeline" } });
  await page.locator("#tl-search").click();
  await expect(page.locator(".cmdk")).toHaveCount(0);
  await expect(page.locator('.nav-item[data-view="search"]')).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#s-input")).toBeFocused();
});

test("while the next keystroke's hits are on their way the previous ones stay, dimmed", async ({ page }) => {
  await bootViewer(page, DATA, { local: NAMES });
  await open(page, "pizza");
  await expect(hits(page)).toHaveCount(5);
  await expect(hits(page).first()).not.toHaveClass(/stale/);
  // type and read the list in the same task — before the 150 ms debounce can fire
  const during = await page.evaluate(() => {
    const inp = document.querySelector(".cmdk-input");
    inp.value = "pizza n"; inp.dispatchEvent(new Event("input", { bubbles: true }));
    const rows = [...document.querySelectorAll(".cmdk-list .cmdk-msg")];
    return { n: rows.length, stale: rows.length > 0 && rows.every((r) => r.classList.contains("stale")),
      dim: rows.length ? Number(getComputedStyle(rows[0]).opacity) < 1 : false,
      busy: document.querySelector(".cmdk-list").getAttribute("aria-busy") };
  });
  expect(during).toEqual({ n: 5, stale: true, dim: true, busy: "true" });
  // the new pass lands: fresh rows, not busy
  await expect(hits(page).first()).not.toHaveClass(/stale/);
  await expect(hits(page)).toHaveCount(5);
  await expect(page.locator(".cmdk-list")).not.toHaveAttribute("aria-busy", "true");
  await expect(seeAll(page)).toContainText("8 messages match");
});
