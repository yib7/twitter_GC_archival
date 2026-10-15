/*
 * SP7 carry-over (SP6 review #2): the setup server parsed the whole built
 * archive (every message body) on its default heap for /api/status,
 * /api/parts, /api/removal-preview and the identity save. A big archive could
 * crash the wizard even though the build itself (sized heap) handled it.
 *
 * Here a ~60 MB synthetic data.js is served by a server started with a 48 MB
 * heap: everything the wizard asks for must still work, because the server
 * now streams the archive and keeps no message bodies. (The rebuild after a
 * removal runs in build.js, which gets its own heap sized to the machine.)
 */
require("./_real-data-guard.js");   // QA-2: refuse to run outside a clean checkout
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../scripts/build-core.js");
const X = require("./fixtures/x-export.js");
const { startServer, readData } = require("./_sp6-server.js");

const BIG = "1000000099";
const N = 250000;
let S, exportRoot;

before(async () => {
  const personal = fs.mkdtempSync(path.join(os.tmpdir(), "gca-sp6-personal-"));
  exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gca-mem-export-"));
  const f = X.writeExport(exportRoot);
  // A big baseline archive: one group, N messages of ~200 characters from 50 people.
  const filler = "the quick brown fox jumps over the lazy dog while the archive keeps every word ".repeat(3);
  const msgs = new Array(N);
  for (let i = 0; i < N; i++) msgs[i] = { i: String(5000000 + i), s: String(700 + (i % 50)), t: X.T0 - (N - i) * 1000, x: i + " " + filler };
  const participants = [...new Set(msgs.map((m) => m.s))];
  const convs = [{ id: BIG, type: "group", title: "Big Group", participants, count: N, msgs, events: [] }];
  const fd = fs.openSync(path.join(personal, "data.js"), "w");
  for (const c of core.archiveChunks({ generatedAt: new Date(X.T0).toISOString(), ignoredUsers: [], ignoredGroups: [] }, convs)) fs.writeSync(fd, c);
  fs.closeSync(fd);
  fs.mkdirSync(path.join(personal, "media"));
  fs.writeFileSync(path.join(personal, "config.json"), JSON.stringify({
    sourceJs: [f.group], headersJs: f.headers, mediaDir: path.join(personal, "media"), ignoredUsers: [], ignoredGroups: [],
  }));
  S = await startServer({}, { personal, nodeArgs: ["--max-old-space-size=48"] });
});
after(() => { if (S) S.stop(); fs.rmSync(exportRoot, { recursive: true, force: true }); });

test("the archive under test is big compared with the server's heap", () => {
  assert.ok(fs.statSync(path.join(S.personal, "data.js")).size > 55 * 1048576);
});

test("/api/status streams the archive: groups and counts, no crash", async () => {
  const r = await S.get("/api/status");
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.built, true);
  assert.deepEqual(j.groups, [{ id: BIG, title: "Big Group", count: N }]);
});

test("/api/parts for the big group streams it: everyone, with counts and samples", async () => {
  const r = await S.get("/api/parts?group=" + BIG);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.parts.length, 50);
  assert.equal(j.parts.reduce((n, p) => n + p.count, 0), N);
  assert.ok(j.parts[0].samples.length > 0);
});

test("/api/removal-preview streams it: counts what a removal would take", async () => {
  const r = await S.post("/api/removal-preview", { ignoredGroups: [], ignoredUsers: ["700"] });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(j, { messages: N / 50, media: 0, groups: 0, people: 1 });
});

test("an identity save that removes a person rebuilds, and the server streams the result", async () => {
  const r = await S.post("/api/identity", { names: { "701": "Ann" }, pfps: {}, gc: {}, ignoredUsers: ["700"], ignoredGroups: [] });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.rebuilt, true);
  assert.equal(j.totalMsgs, N - N / 50 + 5, "the big group without 700, plus the small export part0's 5 group messages");
  const st = await (await S.get("/api/status")).json();
  assert.equal(st.groups.find((g) => g.id === BIG).count, N - N / 50);
  assert.ok(!readData(S.personal).conversations.find((c) => c.id === BIG).msgs.some((m) => m.s === "700"));
});
