require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, expect } = require("@playwright/test");
const { checkAndBuild } = require("./_setup-helpers.js");

// a phone photo is 3-12 MB, but an avatar never needs more than a few
// hundred pixels. The wizard now shrinks every picked photo (person or group)
// to at most 512 px on its long side BEFORE it is kept or uploaded, so a save
// with several photos stays small. All server routes are mocked; the images
// are drawn on a canvas in the page — no real files are involved.

const PARTS = [{ id: "1111", count: 40, samples: ["hello there friend"], media: [] }];
let saved = null;

test.beforeEach(async ({ page }) => {
  saved = null;
  await page.route("**/api/status", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ built: false, groups: [], ignoredGroups: [] }) }));
  await page.route("**/api/source", (route) =>
    route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ totalMsgs: 40, groups: [{ id: "G1", title: "Grp", count: 40 }], mediaCopied: 0 }) }));
  await page.route("**/api/parts*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ parts: PARTS }) }));
  await page.route("**/api/identity", (route) => {
    saved = JSON.parse(route.request().postData() || "{}");
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, names: 0, pfps: 1, ignored: 0 }) });
  });
  await page.goto("/setup.html");
  await page.locator("#src-group").fill("group.js");
  await page.locator("#src-headers").fill("headers.js");
  await page.locator("#src-media").fill("media");
  await checkAndBuild(page, { mock: true });   // Check export → preview → Build
  await expect(page.locator('[data-pane="2"]')).toBeVisible();
});

// A noisy (hard to compress, so genuinely large) image drawn in the page.
async function bigImage(page, w, h, type) {
  const b64 = await page.evaluate(([w, h, type]) => {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d"); const d = x.createImageData(w, h);
    let s = 12345;
    for (let i = 0; i < d.data.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d.data[i] = i % 4 === 3 ? 255 : (s >>> 16) & 255; }
    x.putImageData(d, 0, 0);
    return c.toDataURL(type, 0.95).split(",")[1];
  }, [w, h, type]);
  return Buffer.from(b64, "base64");
}
const dims = (page, url) => page.evaluate((u) => new Promise((res) => {
  const i = new Image(); i.onload = () => res([i.naturalWidth, i.naturalHeight]); i.onerror = () => res(null); i.src = u;
}), url);
const bytesOf = (url) => Buffer.from(url.split(",")[1], "base64").length;

async function pickPersonPhoto(page, file) {
  await page.locator('[data-pane="2"] [data-next]').click();
  const card = page.locator(".su-person").first();
  await expect(card).toBeVisible();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), card.locator(".su-pick").click()]);
  await chooser.setFiles(file);
}
async function saveAll(page) {
  await page.locator('[data-pane="3"] [data-next]').click();
  await page.locator("#btn-save").click();
  await expect(page.locator("#finish-result")).toContainText(/Saved/);
}

test("a large person photo is shrunk to 512 px (aspect kept, PNG stays PNG) before it is saved", async ({ page }) => {
  const buf = await bigImage(page, 2000, 1500, "image/png");
  expect(buf.length).toBeGreaterThan(3 * 1024 * 1024);   // phone-photo sized
  await pickPersonPhoto(page, { name: "big.png", mimeType: "image/png", buffer: buf });
  await page.getByRole("button", { name: /use this photo/i }).click();
  await saveAll(page);
  const url = saved.pfps["1111"];
  expect(url).toMatch(/^data:image\/png;base64,/);
  expect(await dims(page, url)).toEqual([512, 384]);
  expect(bytesOf(url)).toBeLessThan(buf.length / 4);
});

test("a large group photo (JPEG) is shrunk to 512 px and stays JPEG", async ({ page }) => {
  const buf = await bigImage(page, 1200, 3000, "image/jpeg");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator("#gc-pick").click()]);
  await chooser.setFiles({ name: "group.jpg", mimeType: "image/jpeg", buffer: buf });
  await page.getByRole("button", { name: /use this photo/i }).click();
  await page.locator('[data-pane="2"] [data-next]').click();
  await saveAll(page);
  const url = saved.gc.G1.photo;
  expect(url).toMatch(/^data:image\/jpeg;base64,/);
  expect(await dims(page, url)).toEqual([205, 512]);
});

test("a photo already small is kept exactly as picked (never upscaled)", async ({ page }) => {
  const tiny = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  await pickPersonPhoto(page, { name: "tiny.png", mimeType: "image/png", buffer: Buffer.from(tiny, "base64") });
  await page.getByRole("button", { name: /use this photo/i }).click();
  await saveAll(page);
  expect(saved.pfps["1111"]).toBe("data:image/png;base64," + tiny);
});

test("a file that isn't an image still gets the 'not a valid image' message", async ({ page }) => {
  await pickPersonPhoto(page, { name: "notes.png", mimeType: "image/png", buffer: Buffer.from("definitely not an image") });
  await expect(page.locator(".su-modal-msg")).toHaveText(/isn't a valid image/);
  await expect(page.getByRole("button", { name: /use this photo/i })).toBeDisabled();
});
