const { test, expect } = require("@playwright/test");
const { bootViewer, msgs, conv } = require("./_viewer-fixture.js");

// UX-20 (SP3): the default zone is now the viewer's own ("local"). This spec's
// expected dates were written for UTC, so it pins the browser zone to UTC.
test.use({ timezoneId: "UTC" });

// VC-4 / UX-2: the search filter state `F` is module-level and survived a
// conversation switch, while ensureSearch() rebuilt the toolbar with EMPTY
// date inputs and a hard-coded "List" toggle. After switching, results were
// still date-filtered / grid-only / people-filtered by the previous chat's
// settings while the visible controls said "no filters" — e.g. "0 messages
// found" with an empty From box. One source of truth now: switching
// conversation resets the filters (sort + match mode are preferences and are
// kept), and the toolbar is rendered FROM F.
const A = msgs("a", 20, { s: ["u1", "u2"], t0: Date.parse("2024-03-10T08:00:00Z"),
  extra: (k) => (k === 5 ? { m: "sample_media/photo-1.svg", k: "img" } : null) });
const B = msgs("b", 20, { s: ["u3"], t0: Date.parse("2024-06-01T10:00:00Z"), step: 3600000 });
const DATA = { conversations: [conv("A", "Alpha", A), conv("B", "Beta", B)] };

test("VC-4/UX-2: search filters do not leak into another conversation", async ({ page }) => {
  await bootViewer(page, DATA);
  await expect(page.locator("#s-list .msg").first()).toBeVisible();
  // Alpha: From date far in the future, Grid mode, Media, a person.
  await page.locator("#f-from").fill("2024-12-01");
  await page.locator("#f-from").dispatchEvent("change");
  await page.locator('#f-viewtoggle button[data-mode="grid"]').click();
  await page.locator("#f-media").click();
  await page.locator("#f-people").click();
  await page.locator(".popover .pop-item").first().click();
  await expect(page.locator("#s-meta")).toContainText("0 ");

  await page.locator("#conv-select").selectOption("B");
  await expect(page.locator("#brand-title")).toHaveText("Beta");
  await expect(page.locator("#s-meta")).toContainText("Showing all 20 messages");
  await expect(page.locator("#s-list .msg")).toHaveCount(20);
  await expect(page.locator("#f-from")).toHaveValue("");
  await expect(page.locator("#f-date")).not.toHaveClass(/active/);
  await expect(page.locator("#f-media")).not.toHaveClass(/active/);
  await expect(page.locator("#f-people-n")).toBeHidden();
  await expect(page.locator('#f-viewtoggle button[data-mode="list"]')).toHaveClass(/sel/);
  await expect(page.locator("#f-clear-all")).toBeHidden();
});

test("VC-4: sort order and match mode are preferences and survive the switch — and the controls show them", async ({ page }) => {
  await bootViewer(page, DATA);
  await page.locator("#f-sort").selectOption("oldest");
  await page.locator('#f-matchtoggle button[data-mode="exact"]').click();
  await page.locator("#conv-select").selectOption("B");
  await expect(page.locator("#brand-title")).toHaveText("Beta");
  await expect(page.locator("#f-sort")).toHaveValue("oldest");
  await expect(page.locator('#f-matchtoggle button[data-mode="exact"]')).toHaveClass(/sel/);
  await expect(page.locator("#s-list .msg .bubble").first()).toHaveText("b text 0");
});

// VC-15 / AN-17: threadFilter wasn't reset either — choosing 2022 in Alpha and
// switching to a chat with no 2022 threads left 0 cards and no active chip.
test("VC-15/AN-17: the Threads year filter does not leak into another conversation", async ({ page }) => {
  const burst = (p, iso, n) => msgs(p, n, { t0: Date.parse(iso) });
  const TA = [...burst("x22-", "2022-05-01T10:00:00Z", 10), ...burst("x23-", "2023-05-01T10:00:00Z", 10)];
  const TB = burst("y24-", "2024-05-01T10:00:00Z", 10);
  await bootViewer(page, { conversations: [conv("A", "Alpha", TA), conv("B", "Beta", TB)] }, { ls: { "gca.lastView": "threads" } });
  await page.locator('.thr-yr[data-yr="2022"]').click();
  await expect(page.locator(".thr-yr.active")).toHaveText("2022");
  await page.locator("#conv-select").selectOption("B");
  await expect(page.locator("#brand-title")).toHaveText("Beta");
  await expect(page.locator(".thr-yr.active")).toHaveText("All");
  await expect(page.locator(".thr-card")).not.toHaveCount(0);
});

// VC-22: a timezone change left already-rendered Search results in the old
// zone and kept the From/To filter bounds computed for the old zone.
test("VC-22: changing the timezone re-runs the search with bounds recomputed for the new zone", async ({ page }) => {
  // 10 msgs at 02:30Z on Mar 10 (= Mar 9 evening in New York) + 5 at 15:00Z.
  const early = msgs("e", 10, { t0: Date.parse("2024-03-10T02:30:00Z") });
  const late = msgs("l", 5, { t0: Date.parse("2024-03-10T15:00:00Z") });
  await bootViewer(page, { conversations: [conv("A", "Alpha", [...early, ...late])] });
  await page.locator("#f-from").fill("2024-03-10");
  await page.locator("#f-from").dispatchEvent("change");
  await page.locator("#f-to").fill("2024-03-10");
  await page.locator("#f-to").dispatchEvent("change");
  await expect(page.locator("#s-meta")).toContainText("15 messages found");

  await page.locator('.nav-item[data-view="settings"]').click();
  await page.locator("#set-tz").selectOption("America/New_York");
  await page.locator('.nav-item[data-view="search"]').click();
  await expect(page.locator("#s-meta")).toHaveText(/(^|\D)5 messages found/);
  await expect(page.locator("#f-from")).toHaveValue("2024-03-10");
  await expect(page.locator("#s-list .msg-time").first()).toContainText("Mar 10, 2024, 11:04 AM");
});
