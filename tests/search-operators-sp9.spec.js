const { test, expect } = require("@playwright/test");
const { bootViewer, conv, afterSearchRun, collectErrors } = require("./_viewer-fixture.js");

// Search operators are read by the shared
// GCAShared.parseSearchQuery — Unicode names, quoted names with spaces, an
// operator at the very end of the box (no trailing space), and the new
// has:photo|video|link|file and is:pinned. Synthetic data only.
test.use({ timezoneId: "UTC" });

const T = Date.parse("2024-02-01T10:00:00Z");
const H = 3600000;
const LIST = [
  { i: "a1", s: "u1", t: T, x: "pizza tonight" },
  { i: "a2", s: "u2", t: T + H, x: "pizza again", m: "sample_media/photo-1.svg", k: "img" },
  { i: "a3", s: "u3", t: T + 2 * H, x: "café talk", m: "sample_media/clip-1.svg", k: "vid" },
  { i: "a4", s: "u4", t: T + 3 * H, x: "the caf menu", m: "sample_media/report.pdf", k: "file" },
  { i: "a5", s: "u5", t: T + 4 * H, x: "see https://t.co/zz", u: [{ s: "https://t.co/zz", e: "https://example.com/menu", d: "example.com/menu" }] },
  { i: "a6", s: "u1", t: T + 5 * H, x: "pinned pizza plan" },
];
const DATA = { conversations: [conv("A", "Alpha", LIST)] };
const NAMES = 'window.LOCAL_NAMES = {"u1":"Bob","u2":"Bella","u3":"José Álvarez","u4":"Mary-Jane","u5":"Ana María"};';

async function boot(page, ls) {
  await bootViewer(page, DATA, { local: NAMES, ls: Object.assign({ "gca.settings": JSON.stringify({ pins: ["a6", "a2"] }) }, ls || {}) });
  await expect(page.locator("#s-meta")).toContainText("Showing all 6 messages");
}
const search = (page, q) => afterSearchRun(page, () => page.locator("#s-input").fill(q));
const found = (page) => page.locator("#s-list .msg .bubble").allTextContents();

test("from: applies at the end of the box with no trailing space", async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  await search(page, "from:bob");
  await expect(page.locator("#s-meta")).toContainText("2 messages found");
  expect(await found(page)).toEqual(["pinned pizza plan", "pizza tonight"]);
  await search(page, "pizza from:bob");
  await expect(page.locator("#s-meta")).toContainText("2 messages found");
  await search(page, "from:bella pizza");
  expect(await found(page)).toEqual(["pizza again"]);
  expect(errors).toEqual([]);
});

test("Unicode, hyphenated and quoted names", async ({ page }) => {
  await boot(page);
  await search(page, "from:josé");
  expect(await found(page)).toEqual(["café talk"]);
  await search(page, "from:jose");            // accents fold for names
  expect(await found(page)).toEqual(["café talk"]);
  await search(page, "from:mary-jane");
  expect(await found(page)).toEqual(["the caf menu"]);
  await search(page, 'from:"Ana María"');
  expect(await found(page)).toEqual(["see example.com/menu"]);
  await search(page, "from:Álvarez");          // a later word of the name
  expect(await found(page)).toEqual(["café talk"]);
  await search(page, 'from:"User 3"');         // the generic label is an alias
  expect(await found(page)).toEqual(["café talk"]);
});

test("an ambiguous name at the end waits; a name nobody has finds nothing and says so", async ({ page }) => {
  await boot(page);
  await search(page, "from:b");                // Bob or Bella — still choosing
  await expect(page.locator("#s-meta")).toContainText("Showing all 6 messages");
  await search(page, "from:b ");               // bounded: everyone it names
  await expect(page.locator("#s-meta")).toContainText("3 messages found");
  await search(page, "from:zzz");
  await expect(page.locator("#s-meta")).toContainText("0 messages found");
  await expect(page.locator("#s-meta")).toContainText("No one named “zzz”");
});

test("-exclusions are Unicode-aware", async ({ page }) => {
  await boot(page);
  await search(page, "-café");
  await expect(page.locator("#s-meta")).toContainText("5 messages found");
  expect(await found(page)).toContain("the caf menu");
  expect(await found(page)).not.toContain("café talk");
});

test("has:photo | video | link | file and is:pinned", async ({ page }) => {
  await boot(page);
  await search(page, "has:photo");
  expect(await found(page)).toEqual(["pizza again"]);
  await search(page, "has:video");
  expect(await found(page)).toEqual(["café talk"]);
  await search(page, "has:file");
  expect(await found(page)).toEqual(["the caf menu"]);
  await search(page, "has:link");
  expect(await found(page)).toEqual(["see example.com/menu"]);
  await search(page, "has:media");
  await expect(page.locator("#s-meta")).toContainText("3 messages found");
  await search(page, "is:pinned");
  expect(await found(page)).toEqual(["pinned pizza plan", "pizza again"]);
  await search(page, "is:pinned has:photo");
  expect(await found(page)).toEqual(["pizza again"]);
  // half-typed at the end: no filter yet, and not searched as text
  await search(page, "has:ph");
  await expect(page.locator("#s-meta")).toContainText("Showing all 6 messages");
  // the Media / Links pills are untouched by operators
  await expect(page.locator("#f-media")).not.toHaveClass(/active/);
});
