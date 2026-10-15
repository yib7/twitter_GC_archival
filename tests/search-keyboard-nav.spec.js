const { test, expect } = require("@playwright/test");
const { bootViewer, conv, msgs, afterSearchRun } = require("./_viewer-fixture.js");

// SP9: keyboard result navigation in Search. With focus in the result list,
// j / ↓ and k / ↑ move a roving focus between results (pulling in more pages
// as needed), Enter opens the result, c opens its context, b bookmarks it.
// Never while typing in the box, a chip or the autocomplete. The position is
// announced (sparingly) through the existing live region. Synthetic data only.
test.use({ timezoneId: "UTC" });

const T = Date.parse("2024-03-10T12:00:00Z");
const A = msgs("a", 140, { s: ["u1", "u2"], t0: T, x: (k) => "pizza note " + k });
const B = msgs("b", 3, { s: ["u3"], t0: T + 864e5, x: (k) => "pizza from beta " + k });
const DATA = { conversations: [conv("A", "Alpha", A), conv("B", "Beta", B)] };
const NAMES = 'window.LOCAL_NAMES = {"u1":"Ann","u2":"Bo","u3":"Dana"};';
const boot = (page, c) => bootViewer(page, DATA, { local: NAMES, ls: { "gca.conv": c || "A" } });
const active = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return a && a.dataset && a.dataset.pos != null ? { pos: +a.dataset.pos, text: (a.querySelector(".bubble") || a).textContent } : null;
});
const search = (page, q) => afterSearchRun(page, () => page.locator("#s-input").fill(q));

test("j / k and the arrows move between results; the live region says where", async ({ page }) => {
  await boot(page);
  await search(page, "pizza note");
  await page.locator('#s-list [data-pos="0"]').focus();
  await expect.poll(() => active(page)).toMatchObject({ pos: 0, text: "pizza note 139" });
  await page.keyboard.press("j");
  await expect.poll(() => active(page)).toMatchObject({ pos: 1, text: "pizza note 138" });
  // a visible focus: the card keeps the keyboard focus ring
  expect(await page.evaluate(() => document.activeElement.matches(":focus-visible") && getComputedStyle(document.activeElement).outlineStyle !== "none")).toBe(true);
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => active(page)).toMatchObject({ pos: 2 });
  await expect(page.locator("#sr-status")).toHaveText("Result 3 of 140");
  await page.keyboard.press("k");
  await expect.poll(() => active(page)).toMatchObject({ pos: 1 });
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => active(page)).toMatchObject({ pos: 0 });
  // the top stays put
  await page.keyboard.press("k");
  await expect.poll(() => active(page)).toMatchObject({ pos: 0 });
});

test("moving past the loaded page pulls in the next one", async ({ page }) => {
  await boot(page);
  await search(page, "pizza note");
  await page.locator('#s-list [data-pos="0"]').focus();
  for (let k = 0; k < 64; k++) await page.keyboard.press("j");
  await expect.poll(() => active(page)).toMatchObject({ pos: 64, text: "pizza note 75" });
  await expect(page.locator("#s-list .msg:focus")).toBeInViewport();
});

test("keys typed in the search box, a chip or the autocomplete are left alone", async ({ page }) => {
  await boot(page);
  await search(page, "pizza from:a");
  await page.locator("#s-input").press("End");
  await page.keyboard.type(" jk");
  await expect(page.locator("#s-input")).toHaveValue("pizza from:a jk");
  expect(await active(page)).toBeNull();
  await search(page, "pizza from:ann");
  await page.locator("#s-chips .s-chip").first().focus();
  await page.keyboard.press("j");
  await expect(page.locator("#s-chips .s-chip").first()).toBeFocused();
  expect(await active(page)).toBeNull();
});

test("Enter opens the result, c its context, b bookmarks it", async ({ page }) => {
  await boot(page);
  await search(page, "pizza note 13");
  await page.locator('#s-list [data-pos="0"]').focus();
  await page.keyboard.press("j");   // newest first: 139 … 130, then 13
  const at = await active(page);
  await page.keyboard.press("b");
  await expect(page.locator("#s-list .msg:focus .act-pin")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#sr-status")).toHaveText("Bookmarked");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("gca.settings")).pins.length)).toBe(1);
  await page.keyboard.press("b");
  await expect(page.locator("#s-list .msg:focus .act-pin")).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("c");
  await expect(page.locator(".ctx-modal")).toBeVisible();
  await expect(page.locator(".ctx-modal .ctx-center").first()).toContainText(at.text);
  await page.keyboard.press("Escape");
  await expect(page.locator(".ctx-modal")).toHaveCount(0);
  await expect.poll(() => active(page)).toMatchObject({ pos: at.pos });
  await page.keyboard.press("Enter");
  await expect(page.locator('.nav-item[data-view="timeline"]')).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#tl-list .msg.flash")).toContainText(at.text);
});

test("All chats: j / k step over a chat's header into the next group", async ({ page }) => {
  await boot(page, "B");   // Beta's 3 hits first (rows 1-3), Alpha's header is row 4
  await search(page, "pizza");
  await afterSearchRun(page, () => page.locator('#s-scope [data-scope="all"]').click());
  // from a header's button, j enters that group
  await page.locator("#s-list .s-conv-head").first().getByRole("button").focus();
  await page.keyboard.press("j");
  await expect.poll(() => active(page)).toMatchObject({ pos: 1, text: "pizza from beta 2" });
  await page.keyboard.press("j"); await page.keyboard.press("j");
  await expect.poll(() => active(page)).toMatchObject({ pos: 3 });
  await page.keyboard.press("j");
  await expect.poll(() => active(page)).toMatchObject({ pos: 5, text: "pizza note 139" });
  await expect(page.locator("#sr-status")).toHaveText("Result 4 of 143");
  await page.keyboard.press("k");
  await expect.poll(() => active(page)).toMatchObject({ pos: 3 });
  // c on another chat's result: its context lives in that chat
  await page.keyboard.press("j");
  await page.keyboard.press("c");
  await expect(page.locator(".ctx-modal")).toHaveCount(0);
  await expect(page.locator("#sr-status")).toContainText("Enter");
});
