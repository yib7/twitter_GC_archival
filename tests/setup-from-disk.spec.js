const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// The setup wizard runs only through the local server (every step calls its
// /api). Opened from disk, it must show only a styled "start the setup server"
// note: no unstyled wizard below it, no page-wide icon, no "Failed to fetch".
// No archive data is involved; the pages here load none.
const ROOT = path.join(__dirname, "..");

async function expectOnlyServerNote(page) {
  const note = page.locator(".su-unserved");
  await expect(note).toBeVisible();
  await expect(note).toContainText("start-setup.cmd");
  await expect(note).toContainText("start-setup.command");
  await expect(note).toContainText("npm start");
  await expect(page.locator(".setup-shell")).toBeHidden();
  await expect(page.locator(".theme-switch")).toBeHidden();
  const look = await page.evaluate(() => {
    const n = document.querySelector(".su-unserved");
    const cs = getComputedStyle(n);
    return {
      pageBg: getComputedStyle(document.body).backgroundColor,
      noteRadius: parseFloat(cs.borderRadius) || 0,
      notePad: parseFloat(cs.paddingTop) || 0,
      fitsViewport: document.documentElement.scrollHeight <= window.innerHeight,
      text: document.body.innerText,
    };
  });
  // styled: a dark page and a padded, rounded card, not browser defaults
  expect(look.pageBg).not.toBe("rgba(0, 0, 0, 0)");
  expect(look.pageBg).not.toBe("rgb(255, 255, 255)");
  expect(look.noteRadius).toBeGreaterThan(0);
  expect(look.notePad).toBeGreaterThan(0);
  // nothing below the note (the bare wizard's brand icon filled the viewport)
  expect(look.fitsViewport).toBe(true);
  expect(look.text).not.toMatch(/failed to fetch/i);
}

test("src/setup.html opened from disk shows only the start-the-server note", async ({ page }) => {
  await page.goto(pathToFileURL(path.join(ROOT, "src", "setup.html")).href);
  await expectOnlyServerNote(page);
});

// Unzipping v1.5 over a v1.4 folder leaves v1.4's root setup.html behind
// (tests/fixtures/setup-v1.4.html is that file, verbatim). Opened from disk,
// its src/… paths resolve, so it loads the current styles and src/setup.js;
// it must end on the same note, not on a wizard whose buttons all fail.
test("a stale root setup.html from v1.4 opened from disk ends on the same note", async ({ page }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gca-test-stale-setup-"));
  try {
    fs.cpSync(path.join(ROOT, "src"), path.join(dir, "src"), { recursive: true });
    fs.copyFileSync(path.join(__dirname, "fixtures", "setup-v1.4.html"), path.join(dir, "setup.html"));
    await page.goto(pathToFileURL(path.join(dir, "setup.html")).href);
    await expect(page).toHaveURL(/\/src\/setup\.html$/);
    await expectOnlyServerNote(page);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("served at /setup.html the wizard shows and the note does not", async ({ page }) => {
  await page.goto("/setup.html");
  await expect(page.locator(".setup-shell")).toBeVisible();
  await expect(page.locator(".theme-switch")).toBeVisible();
  await expect(page.locator(".su-unserved")).toBeHidden();
});

// The raw file is reachable at /src/setup.html too; there its src/… paths
// miss, exactly as from disk, so it shows the note and nothing else.
test("the raw /src/setup.html alias shows only the note", async ({ page }) => {
  await page.goto("/src/setup.html");
  await expectOnlyServerNote(page);
});
