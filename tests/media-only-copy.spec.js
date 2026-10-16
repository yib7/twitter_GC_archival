const { test, expect } = require("@playwright/test");
const { bootViewer, conv } = require("./_viewer-fixture.js");

// "Copy" was offered on media-only messages; it copied "" and toasted
// "Copied text". Like Quote, it is now offered only when there is text.
const T = Date.parse("2024-03-10T12:00:00Z");
const LIST = [
  { i: "m0", s: "u1", t: T, x: "some words" },
  { i: "m1", s: "u2", t: T + 60000, x: "   ", m: "sample/photo-1.svg", k: "img" },
];
const DATA = { conversations: [conv("A", "Alpha", LIST)] };
// (.msg-acts is display:none until hover, so match buttons by text, not role.)

test("no Copy action on a media-only message; still there on a text message", async ({ page }) => {
  await bootViewer(page, DATA, { ls: { "gca.lastView": "timeline" } });
  const media = page.locator('#view-timeline .msg[data-idx="1"] .msg-acts');
  const text = page.locator('#view-timeline .msg[data-idx="0"] .msg-acts');
  await expect(text.locator("button", { hasText: /^Copy$/ })).toHaveCount(1);
  await expect(media.locator("button", { hasText: /^Copy$/ })).toHaveCount(0);
  await expect(media.locator("button", { hasText: /^Context$/ })).toHaveCount(1);
});
