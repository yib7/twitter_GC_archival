/*
 * the wizard's step 1 is now two clicks — "Check export" shows the
 * pre-flight preview (POST /api/preflight, read-only), then "Build archive"
 * (or "Merge into archive") runs the build (POST /api/source).
 *
 * checkAndBuild(page)            for specs over the real test server
 * checkAndBuild(page, { mock })  for specs that mock the /api routes: also
 *                                mocks /api/preflight with a small, valid
 *                                preview (merged with `mock` if an object)
 */
const { expect } = require("@playwright/test");

const PREVIEW = {
  ok: true, via: "files", swapped: false,
  files: { messages: ["direct-messages-group.js"], headers: ["direct-message-group-headers.js"], media: "direct_messages_group_media" },
  groups: [{ id: "G1", title: "", count: 5, first: Date.UTC(2021, 5, 1), last: Date.UTC(2021, 5, 2), participants: 2, removed: false }],
  totals: { groups: 1, messages: 5, participants: 2, first: Date.UTC(2021, 5, 1), last: Date.UTC(2021, 5, 2) },
  dm: { conversations: 0, messages: 0 },
  media: { files: 0, bytes: 0, unmatched: 0, removed: 0, known: 0 },
  merge: null, warnings: [],
};

async function mockPreflight(page, over) {
  const body = Object.assign({}, PREVIEW, over && typeof over === "object" ? over : {});
  await page.route("**/api/preflight", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
}

async function checkAndBuild(page, opts) {
  if (opts && opts.mock) await mockPreflight(page, opts.mock);
  await page.locator("#btn-build").click();
  await expect(page.locator("#preflight")).toBeVisible();
  // an export older than the archive (or adding
  // nothing new) needs the extra confirm ticked first
  if (opts && opts.olderOk) await page.locator("#pf-older-ok").check();
  await page.locator("#btn-confirm").click();
}

module.exports = { PREVIEW, mockPreflight, checkAndBuild };
