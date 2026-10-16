const { test, expect } = require("@playwright/test");
const fs = require("fs");
const { bootViewer, conv, msgs } = require("./_viewer-fixture.js");

// The download behind an export must not lose its blob URL before the browser
// has read it. Some browsers (Firefox) read it after the click task, so
// revoking it synchronously after a.click() can cancel the download.

const DATA = {
  conversations: [
    conv("A", "Alpha", msgs("a", 4, { x: (k) => "export me " + k })),
    conv("B", "Beta", msgs("b", 2, { x: (k) => "export too " + k })),
  ],
};

async function search(page, q) {
  await page.locator("#s-input").fill(q);
  await expect(page.locator("#s-meta")).toContainText(/message(s)? found/);
}

test.describe("the blob URL behind an export download", () => {
  // Chromium reads the blob during click(), so it never shows the cancelled
  // download. What it can show is the ordering that Firefox trips on: the URL
  // must not be revoked before the click task has finished, and must be
  // released afterwards.
  test("is not revoked before the click task ends, is released later, and the download holds the results", async ({ page }) => {
    await page.addInitScript(() => {
      window.__ev = [];
      let inClickTask = false;
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        inClickTask = true;
        setTimeout(() => { inClickTask = false; window.__ev.push("click-task-ended"); }, 0);
        return click.apply(this, arguments);
      };
      const revoke = URL.revokeObjectURL;
      URL.revokeObjectURL = function (u) { window.__ev.push(inClickTask ? "revoked-too-early" : "revoked"); return revoke.call(URL, u); };
    });
    await bootViewer(page, DATA);
    await search(page, "export");
    const dlP = page.waitForEvent("download");
    await page.locator("#f-export").click();
    const dl = await dlP;
    const text = fs.readFileSync(await dl.path(), "utf8");
    expect(text.split("\n").filter(Boolean)).toHaveLength(4);
    expect(text).toContain("export me 3");
    await expect.poll(() => page.evaluate(() => window.__ev.join(",")), { timeout: 5000 }).toMatch(/revoked$/);
    expect(await page.evaluate(() => window.__ev)).toEqual(["click-task-ended", "revoked"]);
  });
});
