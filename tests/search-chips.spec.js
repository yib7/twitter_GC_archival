const { test, expect } = require("@playwright/test");
const { bootViewer, conv, afterSearchRun, collectErrors } = require("./_viewer-fixture.js");

// every applied operator shows as a removable chip under the
// Search box (a named button — click, Enter, Space, Backspace or Delete
// removes it and edits the query text to match), and after from: the box is
// an ARIA combobox offering participants (display names + aliases, never a
// hidden person). Synthetic data only.
test.use({ timezoneId: "UTC" });

const T = Date.parse("2024-02-01T10:00:00Z");
const H = 3600000;
const LIST = [
  { i: "a1", s: "u1", t: T, x: "pizza tonight" },
  { i: "a2", s: "u2", t: T + H, x: "pizza again", m: "sample_media/photo-1.svg", k: "img" },
  { i: "a3", s: "u3", t: T + 2 * H, x: "pizza talk" },
  { i: "a4", s: "u4", t: T + 3 * H, x: "pizza menu" },
  { i: "a5", s: "u5", t: T + 4 * H, x: "pizza photo", m: "sample_media/photo-2.svg", k: "img" },
  { i: "a6", s: "u1", t: T + 5 * H, x: "more pizza", m: "sample_media/photo-3.svg", k: "img" },
];
const DATA = { conversations: [conv("A", "Alpha", LIST)] };
const NAMES = 'window.LOCAL_NAMES = {"u1":"Bob","u2":"Bella","u3":"José Álvarez","u4":"Mary-Jane","u5":"Ana María"};';
const boot = (page, settings) => bootViewer(page, DATA, { local: NAMES, ls: settings ? { "gca.settings": JSON.stringify(settings) } : {} });
const input = (page) => page.locator("#s-input");
const chips = (page) => page.locator("#s-chips .s-chip");
const ac = (page) => page.locator("#s-ac");

test("applied operators render as named, removable chips that edit the query", async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  await expect(page.locator("#s-chips")).toBeHidden();
  await afterSearchRun(page, () => input(page).fill("pizza from:bob has:photo -tonight"));
  await expect(page.locator("#s-chips")).toHaveAttribute("role", "group");
  await expect(chips(page)).toHaveCount(3);
  await expect(chips(page).nth(0)).toHaveAccessibleName("Remove filter: From Bob");
  await expect(chips(page).nth(1)).toHaveAccessibleName("Remove filter: Has photo");
  await expect(chips(page).nth(2)).toHaveAccessibleName("Remove filter: Not “tonight”");
  await expect(page.locator("#s-meta")).toContainText("1 message found");
  // click: the token leaves the box and the search reruns
  await afterSearchRun(page, () => chips(page).nth(1).click());
  await expect(input(page)).toHaveValue("pizza from:bob -tonight");
  await expect(page.locator("#s-meta")).toContainText("1 message found");
  await expect(chips(page)).toHaveCount(2);
  // focus moves to the chip now in that place (or the box when none is left)
  await expect(chips(page).nth(1)).toBeFocused();
  await afterSearchRun(page, () => page.keyboard.press("Backspace"));
  await expect(input(page)).toHaveValue("pizza from:bob ");
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).nth(0)).toBeFocused();
  await afterSearchRun(page, () => page.keyboard.press("Delete"));
  await expect(input(page)).toHaveValue("pizza ");
  await expect(page.locator("#s-chips")).toBeHidden();
  await expect(input(page)).toBeFocused();
  await expect(page.locator("#s-meta")).toContainText("6 messages found");
  expect(errors).toEqual([]);
});

test("date and pinned chips; a from: naming nobody says so on its chip", async ({ page }) => {
  await boot(page, { pins: ["a2"] });
  await afterSearchRun(page, () => input(page).fill("after:2024-02-01 before:2024-02 is:pinned from:zzz"));
  await expect(chips(page)).toHaveText([/Since Feb 1, 2024/, /Until February 2024/, /Pinned/, /From no one named “zzz”/]);
});

test("from: autocomplete is a combobox listing participants", async ({ page }) => {
  await boot(page);
  const box = input(page);
  await expect(box).toHaveAttribute("role", "combobox");
  await expect(box).toHaveAttribute("aria-expanded", "false");
  await box.fill("pizza from:");
  await expect(ac(page)).toBeVisible();
  await expect(ac(page)).toHaveAttribute("role", "listbox");
  await expect(box).toHaveAttribute("aria-expanded", "true");
  await expect(box).toHaveAttribute("aria-controls", "s-ac");
  await expect(ac(page).getByRole("option")).toHaveCount(5);
  await box.press("End");
  await box.pressSequentially("b");
  await expect(ac(page).getByRole("option")).toHaveText([/Bob/, /Bella/]);
  const active = async () => page.locator("#" + await box.getAttribute("aria-activedescendant"));
  await expect(await active()).toContainText("Bob");
  await box.press("ArrowDown");
  await expect(await active()).toContainText("Bella");
  await expect(await active()).toHaveAttribute("aria-selected", "true");
  await afterSearchRun(page, () => box.press("Enter"));
  await expect(box).toHaveValue("pizza from:Bella ");
  await expect(ac(page)).toBeHidden();
  await expect(box).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#s-meta")).toContainText("1 message found");
  await expect(chips(page)).toHaveText([/From Bella/]);
});

test("autocomplete quotes names with spaces, matches aliases and accents, and hides ignored people", async ({ page }) => {
  await boot(page, { ignoredUsers: ["u4"] });
  const box = input(page);
  await box.fill("from:jose");
  await expect(ac(page).getByRole("option")).toHaveText([/José Álvarez/]);
  await box.fill("from:user 5");      // bounded "from:user" — no suggestions
  await expect(ac(page)).toBeHidden();
  await box.fill("from:ana");
  await expect(ac(page).getByRole("option")).toHaveText([/Ana María/]);
  await afterSearchRun(page, () => box.press("Tab"));
  await expect(box).toHaveValue('from:"Ana María" ');
  await expect(box).toBeFocused();
  await box.fill("from:m");
  await expect(ac(page).getByRole("option")).toHaveText([/Ana María/]);   // Mary-Jane is hidden
  // Escape closes the list and keeps the text
  await box.press("Escape");
  await expect(ac(page)).toBeHidden();
  await expect(box).toHaveValue("from:m");
  // an option can be picked with the mouse
  await box.fill("from:");
  await afterSearchRun(page, () => ac(page).getByRole("option", { name: /Bob/ }).click());
  await expect(box).toHaveValue("from:Bob ");
});

// Removing a chip is an edit of the box the browser can undo —
// Ctrl/Cmd+Z in the box brings the token (and its chip) back. Chromium
// implements execCommand("insertText") on inputs (the suite runs Chromium
// only); where it isn't, the box is set directly, without an undo entry.
test("removing a chip can be undone with Ctrl+Z in the box", async ({ page }) => {
  await boot(page);
  await afterSearchRun(page, () => input(page).fill("pizza from:bob has:photo"));
  await expect(chips(page)).toHaveCount(2);
  await afterSearchRun(page, () => chips(page).nth(1).click());
  await expect(input(page)).toHaveValue("pizza from:bob ");
  await expect(chips(page)).toHaveCount(1);
  await input(page).focus();
  await afterSearchRun(page, () => page.keyboard.press("ControlOrMeta+z"));
  await expect(input(page)).toHaveValue("pizza from:bob has:photo");
  await expect(chips(page)).toHaveCount(2);
  await expect(page.locator("#s-meta")).toContainText("1 message found");
});
