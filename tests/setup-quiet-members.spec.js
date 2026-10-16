require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, expect } = require("@playwright/test");
const { checkAndBuild } = require("./_setup-helpers.js");

// someone who never posted (a lurker, or a person known only from the
// headers file) still gets a card in step 3, so they can be named instead of
// staying "User 1234". Their card says "No messages" and, when known, when
// they joined / left. All server routes are mocked with made-up data.
// label: the viewer's "User N" for that chat, which /api/parts sends along
const PARTS = [
  { id: "1111", count: 40, samples: ["hello there friend"], media: [], label: "User 1" },
  { id: "4444", count: 0, samples: [], media: [], joined: Date.UTC(2021, 2, 15, 12), left: Date.UTC(2022, 6, 20, 12), label: "User 2" },
  { id: "5555", count: 0, samples: [], media: [], label: "User 3" },
];

test.beforeEach(async ({ page }) => {
  await page.route("**/api/status", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ built: false, groups: [], ignoredGroups: [] }) }));
  await page.route("**/api/source", (route) =>
    route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ totalMsgs: 40, groups: [{ id: "G1", title: "Grp", count: 40 }], mediaCopied: 0 }) }));
  await page.route("**/api/parts*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ parts: PARTS }) }));
  await page.goto("/setup.html");
  await page.locator("#src-group").fill("group.js");
  await page.locator("#src-headers").fill("headers.js");
  await page.locator("#src-media").fill("media");
  await checkAndBuild(page, { mock: true });   // Check export → preview → Build
  await page.locator('[data-pane="2"] [data-next]').click();
});

test("a member with no messages gets a card that says so, with joined / left dates", async ({ page }) => {
  const cards = page.locator(".su-person");
  await expect(cards).toHaveCount(3);
  const quiet = cards.nth(1);
  await expect(quiet.locator(".su-meta")).toContainText(/No messages/);
  await expect(quiet.locator(".su-meta")).toContainText(/joined Mar 2021/);
  await expect(quiet.locator(".su-meta")).toContainText(/left Jul 2022/);
  await expect(quiet.locator(".su-meta")).not.toContainText(/0 messages/);
  await expect(cards.nth(2).locator(".su-meta")).toContainText(/No messages/);
  await expect(cards.nth(0).locator(".su-meta")).toContainText(/40 messages/);
});

test("a quiet member can be named and saved like anyone else", async ({ page }) => {
  let saved = null;
  await page.route("**/api/identity", (route) => {
    saved = JSON.parse(route.request().postData() || "{}");
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, names: 1, pfps: 0, ignored: 0 }) });
  });
  await page.locator(".su-person").nth(1).locator(".su-name").fill("Quiet Quinn");
  await page.locator('[data-pane="3"] [data-next]').click();
  await page.locator("#btn-save").click();
  await expect(page.locator("#finish-result")).toContainText(/Saved/);
  expect(saved.names["4444"]).toBe("Quiet Quinn");
});

// An unnamed person reads as the viewer's "User N" for this chat, here as in
// the archive, not "User 1234" from the end of their id.
test("an unnamed person's card uses the chat's User N, as the viewer does", async ({ page }) => {
  const cards = page.locator(".su-person");
  for (const [k, label, ini] of [[0, "User 1", "U1"], [1, "User 2", "U2"], [2, "User 3", "U3"]]) {
    await expect(cards.nth(k).locator(".su-name")).toHaveAttribute("placeholder", label);
    await expect(cards.nth(k).locator(".su-av")).toHaveText(ini);
  }
  // a name typed and cleared again goes back to the label
  await cards.nth(1).locator(".su-name").fill("Quinn");
  await expect(cards.nth(1).locator(".su-av")).toHaveText("QU");
  await cards.nth(1).locator(".su-name").fill("");
  await expect(cards.nth(1).locator(".su-av")).toHaveText("U2");
  // the Finish summary's avatars too
  await page.locator('[data-pane="3"] [data-next]').click();
  await expect(page.locator("#fin-receipt .fr-av")).toHaveText(["U1", "U2", "U3"]);
});
