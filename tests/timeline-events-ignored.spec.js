const { test, expect } = require("@playwright/test");
const { bootViewer, conv, msgs, collectErrors } = require("./_viewer-fixture.js");

// An ignored person disappears from the Timeline's system events too: they
// read "Someone" when they act, and a join or leave that is only about them
// isn't shown. Synthetic data only.
test.use({ timezoneId: "UTC" });

const T = Date.parse("2024-03-10T12:00:00Z");
const LIST = msgs("a", 6, { s: ["u1", "u3"], t0: T });
const EVENTS = [
  { t: T - 4000, type: "create", s: "u2" },
  { t: T - 3000, type: "name", s: "u2", name: "Crew" },
  { t: T - 2000, type: "join", s: "u2", ids: ["u3"] },
  { t: T - 1000, type: "join", s: "u1", ids: ["u2"] },
  { t: T + 90000, type: "join", s: "u1", ids: ["u2", "u4"] },
  { t: T + 150000, type: "leave", ids: ["u2"] },
];
const DATA = { conversations: [conv("A", "Alpha", LIST, { events: EVENTS, participants: ["u1", "u2", "u3", "u4"] })] };
const NAMES = 'window.LOCAL_NAMES = {"u1":"Ann","u2":"Bob","u3":"Cy","u4":"Di"};';

test("an ignored person's name is never shown in system events", async ({ page }) => {
  const errors = collectErrors(page);
  await bootViewer(page, DATA, { local: NAMES, ls: { "gca.lastView": "timeline", "gca.settings": JSON.stringify({ ignoredUsers: ["u2"] }) } });
  const lines = page.locator("#view-timeline .sysline");
  await expect(page.locator("#view-timeline .msg").first()).toBeVisible();
  await expect(lines).toHaveText([
    "Someone created the conversation",
    "Someone named the group “Crew”",
    "Someone added Cy",
    "Ann added Di",
  ]);
  expect(errors).toEqual([]);
});

test("without the ignore, the same events name everyone", async ({ page }) => {
  await bootViewer(page, DATA, { local: NAMES, ls: { "gca.lastView": "timeline" } });
  await expect(page.locator("#view-timeline .sysline")).toHaveText([
    "Bob created the conversation",
    "Bob named the group “Crew”",
    "Bob added Cy",
    "Ann added Bob",
    "Ann added Bob, Di",
    "Bob left",
  ]);
});
