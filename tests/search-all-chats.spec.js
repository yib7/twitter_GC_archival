const { test, expect } = require("@playwright/test");
const { bootViewer, conv, msgs, afterSearchRun } = require("./_viewer-fixture.js");

// Search's "All chats" scope — one query across every visible
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

test("Export writes the groups, one record per line, under each chat's name", async ({ page }) => {
  const fs = require("fs");
  await boot(page);
  await search(page, "pizza");
  await afterSearchRun(page, () => scopeBtn(page, "all").click());
  const dlP = page.waitForEvent("download");
  await page.locator("#f-export").click();
  const dl = await dlP;
  expect(dl.suggestedFilename()).toMatch(/^search-results-all-chats-\d{4}-\d{2}-\d{2}\.txt$/);
  const text = fs.readFileSync(await dl.path(), "utf8");
  const lines = text.split("\n");
  expect(lines.filter((l) => l.startsWith("== "))).toEqual(["== Alpha ==", "== Beta ==", "== Gamma =="]);
  const recs = lines.filter((l) => l && !l.startsWith("== "));
  expect(recs).toHaveLength(10);
  for (const l of recs) expect(l).toMatch(/ \| .+: pizza party number \d+$/);
  expect(lines[1]).toContain("Ann: pizza party number 6");
});

// The active chat's cached cross-chat index is dropped when it
// becomes active (it searches through MSGS/LOWER then) and rebuilt lazily
// once it is "another chat" again — results stay right across the switches.
test("switching chats back and forth keeps All chats results right", async ({ page }) => {
  await boot(page, { ignoredUsers: ["u9"] });
  await afterSearchRun(page, () => scopeBtn(page, "all").click());
  await search(page, "pizza");
  await expect(page.locator("#s-meta")).toContainText("9 messages in 3 chats");
  for (const [id, title] of [["B", "Beta"], ["A", "Alpha"], ["B", "Beta"]]) {
    await page.locator("#conv-select").selectOption(id);
    await expect(page.locator("#brand-title")).toHaveText(title);
    await search(page, "pizza");
    await expect(page.locator("#s-meta")).toContainText("9 messages in 3 chats");
    await expect(heads(page).first()).toContainText(title);
    await expect(page.locator("#s-list")).not.toContainText("Gus");
  }
});

// Unnamed people get a per-chat "User N" (by how much they post there). A row
// from another chat must use THAT chat's label — the one its own view shows —
// in All chats results, the export, Pinned and from:, never the "User 1234"
// fallback or the active chat's numbering.
test.describe("unnamed people in other chats keep their own chat's User N", () => {
  const P = "3000001006";                       // 2nd-most-active in Beta; not in Alpha
  const SHARED = "1000000001";                  // User 1 in Alpha, User 3 in Beta
  const UA = msgs("ua", 5, { s: [SHARED, "1000000002", SHARED, "1000000002", SHARED], t0: T, x: (k) => "pizza a" + k });
  // b3 (P) and b5 (SHARED) carry several files, so their extra files are labelled too
  const MULTI = { m: "sample_media/photo-1.svg", k: "img", mx: [{ m: "sample_media/photo-2.svg", k: "img" }, { m: "sample_media/clip-1.svg", k: "vid" }] };
  const UB = msgs("ub", 6, { s: ["2000000007", P, "2000000007", P, "2000000007", SHARED], t0: T + 864e5, x: (k) => "pizza b" + k,
    extra: (k) => (k === 3 || k === 5 ? MULTI : null) });
  const UDATA = { conversations: [conv("A", "Alpha", UA), conv("B", "Beta", UB)] };
  const uboot = (page, ls) => bootViewer(page, UDATA, { ls: Object.assign({ "gca.conv": "A" }, ls || {}) });
  const betaRows = (page) => page.locator("#s-list .msg").filter({ hasText: /pizza b\d/ });
  const nameIn = (row) => row.locator(".msg-name");

  test("All chats rows, the export and from: use the other chat's label", async ({ page }) => {
    const fs = require("fs");
    await uboot(page);
    await afterSearchRun(page, () => scopeBtn(page, "all").click());
    await search(page, "pizza");
    await expect(page.locator("#s-meta")).toContainText("11 messages in 2 chats");
    await expect(betaRows(page)).toHaveCount(6);
    await expect(page.locator("#s-list")).not.toContainText(/User \d{4}/);
    await expect(nameIn(betaRows(page).filter({ hasText: "pizza b3" }))).toHaveText("User 2");
    await expect(nameIn(betaRows(page).filter({ hasText: "pizza b5" }))).toHaveText("User 3");
    await expect(nameIn(page.locator("#s-list .msg").filter({ hasText: "pizza a4" }))).toHaveText("User 1");
    // the extra files on those rows name the same person
    for (const [k, label] of [["b3", "User 2"], ["b5", "User 3"]]) {
      const more = betaRows(page).filter({ hasText: "pizza " + k }).locator(".media-more-item");
      await expect(more.nth(0)).toHaveAttribute("aria-label", new RegExp("^Open photo 2 of 3 from " + label + " · "));
      await expect(more.nth(1)).toHaveAttribute("aria-label", new RegExp("^Video 3 of 3 from " + label + " · "));
    }
    // the export says the same
    const dlP = page.waitForEvent("download");
    await page.locator("#f-export").click();
    const text = fs.readFileSync(await (await dlP).path(), "utf8");
    expect(text).not.toMatch(/User \d{4}/);
    expect(text).toMatch(/\| User 2: pizza b3$/m);
    expect(text).toMatch(/\| User 3: pizza b5$/m);
    expect(text).toMatch(/\| User 2: pizza a3$/m);
    // from:"User 2" is each chat's User 2: 1000000002 in Alpha, P in Beta
    await search(page, 'from:"User 2" pizza');
    await expect(page.locator("#s-meta")).toContainText("4 messages in 2 chats");
    await expect(betaRows(page)).toHaveCount(2);
    for (const k of ["b1", "b3"]) await expect(betaRows(page).filter({ hasText: "pizza " + k })).toHaveCount(1);
    await expect(page.locator("#s-chips .s-chip")).toContainText("From User 2");
    // and Beta's own view shows the same label
    await page.locator("#conv-select").selectOption("B");
    await page.locator('.nav-item[data-view="timeline"]').click();
    await expect(nameIn(page.locator("#view-timeline .msg").filter({ hasText: "pizza b3" }))).toHaveText("User 2");
  });

  test("the from: suggestion's avatar matches its label", async ({ page }) => {
    await uboot(page);
    await afterSearchRun(page, () => scopeBtn(page, "all").click());
    await page.locator("#s-input").fill('from:"User 3');
    // SHARED is User 3 in Beta (and User 1 here): its avatar reads U3, not U1
    const opt = page.locator("#s-ac [role=option]").filter({ hasText: "User 3" });
    await expect(opt).toHaveCount(1);
    await expect(opt.locator(".av")).toHaveText("U3");
  });

  test("a pin from another chat shows that chat's label", async ({ page }) => {
    await uboot(page, { "gca.lastView": "pins", "gca.settings": JSON.stringify({ pins: ["ub1", "ub5"] }) });
    const row = page.locator("#view-pins .msg").filter({ hasText: "pizza b1" });
    await expect(nameIn(row)).toHaveText("User 2");
    const multi = page.locator("#view-pins .msg").filter({ hasText: "pizza b5" });
    await expect(nameIn(multi)).toHaveText("User 3");
    await expect(multi.locator(".media-more-item").first()).toHaveAttribute("aria-label", /^Open photo 2 of 3 from User 3 · /);
    const dlP = page.waitForEvent("download");
    await page.locator("#pins-export").click();
    const text = require("fs").readFileSync(await (await dlP).path(), "utf8");
    expect(text).toMatch(/\| User 2: pizza b1$/m);
  });
});
