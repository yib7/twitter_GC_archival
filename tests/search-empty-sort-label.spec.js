const { test, expect } = require("@playwright/test");
const { bootViewer, conv, msgs, afterSearchRun } = require("./_viewer-fixture.js");

// With an empty search box Search lists every message in the chosen sort
// order; the meta line must name that order, in This chat and All chats.
// Synthetic data only.
test.use({ timezoneId: "UTC" });

const DATA = { conversations: [conv("A", "Alpha", msgs("a", 5)), conv("B", "Beta", msgs("b", 3, { s: ["u3"] }))] };

test("the empty-query line names the chosen sort order", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.conv": "A" } });
  const meta = page.locator("#s-meta");
  await expect(meta).toContainText("Showing all 5 messages, newest first");
  for (const [value, words] of [["oldest", "oldest first"], ["longest", "longest first"], ["reactions", "most reactions first"], ["newest", "newest first"]]) {
    await afterSearchRun(page, () => page.locator("#f-sort").selectOption(value));
    await expect(meta).toContainText("Showing all 5 messages, " + words);
  }
  await afterSearchRun(page, () => page.locator("#f-sort").selectOption("oldest"));
  await afterSearchRun(page, () => page.locator('#s-scope button[data-scope="all"]').click());
  await expect(meta).toContainText("Showing all 8 messages in 2 chats, oldest first");
  await expect(meta).not.toContainText("newest");
});
