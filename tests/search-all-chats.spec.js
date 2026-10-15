const { test, expect } = require("@playwright/test");
const { bootViewer, conv, msgs, afterSearchRun } = require("./_viewer-fixture.js");

// SP9: Search's "All chats" scope — one query across every visible
// conversation, results grouped per chat (header + count + a button that
// searches just that chat), windowed like This chat. Removed groups and
// ignored people stay out; the scope rides in the address (#…&s=all), the
// query never does. Exact matches only (no typo-tolerant pass across chats).
// Synthetic data only.
test.use({ timezoneId: "UTC" });

const T = Date.parse("2024-03-10T12:00:00Z");
const pizza = (every) => (k) => (k % every === 0 ? "pizza party number " + k : "small talk " + k);
const A = msgs("a", 9, { s: ["u1", "u2"], t0: T, x: pizza(3) });                   // 3 pizza (a0 a3 a6)
const B = msgs("b", 6, { s: ["u3", "u4", "u9"], t0: T + 864e5, x: pizza(2) });     // pizza b0 (u3) b2 (u9) b4 (u4)
const C = msgs("c", 4, { s: ["u5"], t0: T + 2 * 864e5, x: pizza(1) });             // 4 pizza
const NAMES = 'window.LOCAL_NAMES = {"u1":"Ann","u2":"Bo","u3":"Dana","u4":"Eli","u5":"Fay","u9":"Gus"};';
const DATA = { conversations: [conv("A", "Alpha", A), conv("B", "Beta", B), conv("C", "Gamma", C)] };

const boot = (page, extra, opts) => bootViewer(page, Object.assign({}, DATA, extra || {}),
  Object.assign({ local: NAMES, ls: { "gca.conv": "A" } }, opts || {}));
const scopeBtn = (page, s) => page.locator(`#s-scope button[data-scope="${s}"]`);
const heads = (page) => page.locator("#s-list .s-conv-head");
const search = async (page, q) => afterSearchRun(page, () => page.locator("#s-input").fill(q));

test("the scope toggle searches every chat, grouped with counts; the URL carries the scope, never the query", async ({ page }) => {
  await boot(page);
  await expect(scopeBtn(page, "this")).toHaveAttribute("aria-pressed", "true");
  await search(page, "pizza");
  await expect(page.locator("#s-meta")).toContainText("3 messages found");
  await afterSearchRun(page, () => scopeBtn(page, "all").click());
  await expect(scopeBtn(page, "all")).toHaveAttribute("aria-pressed", "true");
  await expect(scopeBtn(page, "this")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#s-meta")).toContainText("10 messages in 3 chats");
  // the active chat first, then picker order; each header names the chat and its count
  await expect(heads(page)).toHaveCount(3);
  await expect(heads(page).nth(0)).toContainText("Alpha");
  await expect(heads(page).nth(0)).toContainText("3 messages");
  await expect(heads(page).nth(0)).toContainText("this chat");
  await expect(heads(page).nth(1)).toContainText("Beta");
  await expect(heads(page).nth(1)).toContainText("3 messages");
  await expect(heads(page).nth(2)).toContainText("Gamma");
  await expect(page.locator("#s-list .msg")).toHaveCount(10);
  await expect(page.locator("#s-list .msg mark").first()).toHaveText("pizza");
  // exact only across chats: no Fuzzy/Exact or Grid switch
  await expect(page.locator("#f-matchtoggle")).toBeHidden();
  await expect(page.locator("#f-viewtoggle")).toBeHidden();
  await expect(page.locator("#s-fuzzy-toggle")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => location.hash)).toContain("s=all");
  expect(page.url()).not.toContain("pizza");
  // back to This chat drops the flag
  await afterSearchRun(page, () => scopeBtn(page, "this").click());
  await expect(page.locator("#s-meta")).toContainText("3 messages found");
  await expect(heads(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => location.hash)).not.toContain("s=");
});

test("one conversation: no scope toggle", async ({ page }) => {
  await bootViewer(page, { conversations: [conv("A", "Alpha", A)] }, { local: NAMES });
  await expect(page.locator("#s-input")).toBeVisible();
  await expect(page.locator("#s-scope")).toBeHidden();
});

test("a result from another chat opens it there; Back returns to the all-chats results", async ({ page }) => {
  await boot(page);
  await afterSearchRun(page, () => scopeBtn(page, "all").click());
  await search(page, "pizza party number 4");
  await expect(heads(page)).toHaveCount(1);   // only Beta holds b4
  await expect(page.locator("#s-list .msg")).toHaveCount(1);
  await page.locator("#s-list .msg").first().click();
  await expect(page.locator("#brand-title")).toHaveText("Beta");
  await expect(page.locator('.nav-item[data-view="timeline"]')).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#tl-list .msg.flash")).toContainText("pizza party number 4");
  await page.goBack();
  await expect(page.locator('.nav-item[data-view="search"]')).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#brand-title")).toHaveText("Alpha");
  await expect(page.locator("#s-input")).toHaveValue("pizza party number 4");
  await expect(scopeBtn(page, "all")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#s-list .msg")).toHaveCount(1);
});

test("a group's button searches just that chat with the same query", async ({ page }) => {
  await boot(page);
  await afterSearchRun(page, () => scopeBtn(page, "all").click());
  await search(page, "pizza");
  const btn = heads(page).nth(1).getByRole("button");
  await expect(btn).toHaveAccessibleName(/Search only Beta/);
  await btn.click();
  await expect(page.locator("#brand-title")).toHaveText("Beta");
  await expect(page.locator("#s-input")).toHaveValue("pizza");
  await expect(scopeBtn(page, "this")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#s-meta")).toContainText("3 messages found");
  await expect(heads(page)).toHaveCount(0);
});

test("removed group chats and ignored people stay out of All chats", async ({ page }) => {
  await boot(page, { ignoredGroups: ["C"], ignoredUsers: ["u9"] });
  await afterSearchRun(page, () => scopeBtn(page, "all").click());
  await search(page, "pizza");
  await expect(page.locator("#s-meta")).toContainText("5 messages in 2 chats");
  await expect(heads(page)).toHaveCount(2);
  await expect(page.locator("#s-list")).not.toContainText("Gamma");
  await expect(page.locator("#s-list")).not.toContainText("Gus");
});

test("from: names people from every chat; an address with s=all opens the scope", async ({ page }) => {
  await boot(page, null, { goto: false });
  await page.goto("/#v=search&c=A&s=all");
  await expect(scopeBtn(page, "all")).toHaveAttribute("aria-pressed", "true");
  await search(page, "from:dana pizza");
  await expect(page.locator("#s-meta")).toContainText("1 message in 1 chat");
  await expect(heads(page)).toHaveCount(1);
  await expect(heads(page).first()).toContainText("Beta");
  await expect(page.locator("#s-chips .s-chip")).toContainText("From Dana");
  // the autocomplete offers people from the other chats too
  await page.locator("#s-input").fill("from:f");
  await expect(page.locator("#s-ac [role=option]").first()).toContainText("Fay");
});

test("no hit in any chat says so and offers This chat's close matches", async ({ page }) => {
  await boot(page);
  await afterSearchRun(page, () => scopeBtn(page, "all").click());
  await search(page, "pizzza");
  await expect(page.locator("#s-list .empty")).toContainText("No messages match in any chat");
  await expect(page.locator("#s-list .empty")).toContainText("exact");
});
