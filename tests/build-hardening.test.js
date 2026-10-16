/*
 * The build against a crafted export: values of the wrong type, ids that are
 * names of Object.prototype members, inputs sized to make a loop or a regex
 * run for minutes, and failure messages that would print the user's paths.
 * Every export here is synthetic (tests/fixtures/x-export.js helpers).
 */
require("./_real-data-guard.js");   // refuse to run outside a clean checkout
const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const core = require("../scripts/build-core.js");
const { X_LINK } = require("../src/shared-core.js");
const X = require("./fixtures/x-export.js");

const tmpDirs = [];
const scratch = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const ms = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };

describe("missingPartNumbers stays small for an absurd part number", () => {
  test("part 9999999999 in a file's first line returns at once with a short list", () => {
    let out;
    const took = ms(() => { out = core.missingPartNumbers([0, 9999999999]); });
    assert.ok(took < 1000, "took " + took + " ms");
    assert.ok(out.length <= 50, "listed " + out.length);
    assert.deepEqual(out.slice(0, 3), [1, 2, 3]);
  });
  test("an ordinary gap is still listed exactly", () => {
    assert.deepEqual(core.missingPartNumbers([0, 1, 3, 5]), [2, 4]);
    assert.deepEqual(core.missingPartNumbers([2]), [0, 1]);
  });
});

describe("X_LINK runs in linear time and still finds X links", () => {
  test("a 200,000-character word is checked quickly", () => {
    const s = "a".repeat(200000);
    const took = ms(() => { assert.equal(X_LINK.test(s), false); });
    assert.ok(took < 500, "took " + took + " ms");
  });
  test("X and Twitter links still match; other sites ending in x.com don't", () => {
    for (const s of ["https://x.com/someone/status/1", "see t.co/abc", "http://mobile.twitter.com/a", "twitter.com/a", "(https://www.x.com/i/x)"]) assert.ok(X_LINK.test(s), s);
    for (const s of ["https://netflix.com/title/1", "dropbox.com/s/abc", "abct.co/x", "just words"]) assert.ok(!X_LINK.test(s), s);
  });
  test("a link starts a word or follows its scheme, wherever the scheme starts", () => {
    for (const s of ["x.com/a", "ok\nt.co/a", "ftp://x.com/a", "see:twitter.com/a", "xhttps://x.com/a", "HTTPS://T.CO/A", "[x.com/a]"]) assert.ok(X_LINK.test(s), s);
    for (const s of ["a-x.com/a", "_t.co/a", "9twitter.com/a", "x.com", "x.co/a", "https://x.comm/a"]) assert.ok(!X_LINK.test(s), s);
  });
  test("other long inputs are checked quickly too", () => {
    for (const s of ["a.".repeat(100000), "-".repeat(200000), " a".repeat(100000), "http://".repeat(30000), "x.co".repeat(50000), "a-".repeat(100000) + "x.com"]) {
      const took = ms(() => { X_LINK.test(s); });
      assert.ok(took < 500, s.slice(0, 8) + "… took " + took + " ms");
    }
  });
});

describe("merging many copies of one message stays fast", () => {
  test("20,000 copies of one id, each with a new reaction, keep every reaction", () => {
    const acc = core.createAccumulator({});
    const N = 20000;
    const took = ms(() => {
      for (let k = 0; k < N; k++) acc.addMessage("1000000001", X.gmsg(9001, 111, X.T0, "same", { reactions: [{ reactionKey: "like", senderId: String(100000 + k) }] }));
    });
    assert.ok(took < 5000, "took " + took + " ms");
    const m = acc.finish({}).conversations[0].msgs[0];
    assert.equal(m.r.length, N);
  });
  test("a reaction seen twice is still kept once", () => {
    const acc = core.createAccumulator({});
    for (let k = 0; k < 3; k++) acc.addMessage("1000000001", X.gmsg(9001, 111, X.T0, "same", { reactions: [{ reactionKey: "like", senderId: "222" }] }));
    assert.equal(acc.finish({}).conversations[0].msgs[0].r.length, 1);
  });
});

describe("export fields of the wrong type", () => {
  test("rawToRec keeps ids and senders as text, text as text, and drops malformed links and reactions", () => {
    const r = core.rawToRec({ id: 9001, senderId: 111, createdAt: "2021-06-01T12:00:00Z", text: 5,
      urls: [{ url: "https://t.co/a", expanded: "https://example.com/a", display: "example.com/a" }, "junk", { url: { a: 1 }, expanded: 7 }],
      reactions: [{ reactionKey: "like", senderId: 222 }, null, { reactionKey: { a: 1 }, senderId: "333" }] });
    assert.equal(r.i, "9001");
    assert.equal(r.s, "111");
    assert.equal(r.x, "5");
    assert.deepEqual(r.u, [{ s: "https://t.co/a", e: "https://example.com/a", d: "example.com/a" }]);
    assert.deepEqual(r.r, [{ k: "like", s: "222" }]);
  });
  test("an object as the text or the sender never reaches data.js", () => {
    const r = core.rawToRec({ id: "9001", senderId: { o: 1 }, createdAt: "2021-06-01T12:00:00Z", text: { a: [1] } });
    assert.equal(r.x, "");
    assert.equal(r.s, null);
    assert.equal(core.rawToRec({ id: { a: 1 }, senderId: "1", text: "x" }).i, null);
  });
  test("a sender that is an object is skipped like a missing one", () => {
    const acc = core.createAccumulator({});
    acc.addMessage("1000000001", { messageCreate: { id: "9001", senderId: { o: 1 }, createdAt: "2021-06-01T12:00:00Z", text: "hi" } });
    acc.addMessage("1000000001", X.gmsg(9002, 111, X.T0, "kept"));
    const out = acc.finish({});
    assert.deepEqual(out.conversations[0].msgs.map((m) => m.i), ["9002"]);
    assert.equal(out.warnings.noSender, 1);
  });
  test("a group name event with a non-text name or member list is made safe", () => {
    const acc = core.createAccumulator({});
    acc.addMessage("1000000001", X.gmsg(9001, 111, X.T0, "hi"));
    acc.addMessage("1000000001", { conversationNameUpdate: { initiatingUserId: 111, name: { evil: 1 }, createdAt: "2021-06-01T12:00:01Z" } });
    acc.addMessage("1000000001", { participantsJoin: { initiatingUserId: "111", userIds: "444", createdAt: "2021-06-01T12:00:02Z" } });
    acc.addMessage("1000000001", { participantsLeave: { userIds: [555, { x: 1 }], createdAt: "2021-06-01T12:00:03Z" } });
    const c = acc.finish({}).conversations[0];
    const ev = Object.fromEntries(c.events.map((e) => [e.type, e]));
    assert.equal(typeof c.title, "string");
    assert.equal(ev.name.s, "111");
    assert.deepEqual(ev.join.ids, []);
    assert.deepEqual(ev.leave.ids, ["555"]);
  });
});

describe("ids named like Object.prototype members", () => {
  test("a message id of constructor / __proto__ / toString gets no media from the prototype", () => {
    const acc = core.createAccumulator({});
    for (const id of ["constructor", "__proto__", "toString", "9001"]) acc.addMessage("1000000001", X.gmsg(id, 111, X.T0, "msg " + id));
    const msgs = acc.finish({ 9001: ["personal_data/media/9001-a.png"] }).conversations[0].msgs;
    for (const m of msgs) {
      if (m.i === "9001") assert.equal(m.m, "personal_data/media/9001-a.png");
      else assert.equal(m.m, undefined, m.i + " got " + JSON.stringify(m.m));
    }
  });
  test("indexMediaFiles keeps only files named after a numeric message id", () => {
    const idx = core.indexMediaFiles(["constructor-1.jpg", "__proto__-2.png", "toString-3.png", "9001-a.png"], "personal_data/media");
    assert.deepEqual(Object.keys(idx), ["9001"]);
    assert.equal(Object.getPrototypeOf(idx), Object.prototype);
  });
});

describe("what a failed build tells the user", () => {
  const { describeFailure } = require("../scripts/build.js");
  const sys = (code, p, syscall) => Object.assign(new Error(code + ": failed, " + syscall + " '" + p + "'"), { code, path: p, syscall });
  test("permission and other system errors name the file, not its full path", () => {
    for (const [code, p, base] of [["EACCES", "/home/jane/x/data.js", "data.js"], ["EPERM", "/Users/jane/media/1-a.png", "1-a.png"], ["ELOOP", "/home/jane/export/data", "data"], ["EIO", "/media/jane/disk/x.js", "x.js"]]) {
      const msg = describeFailure(sys(code, p, "open"));
      assert.doesNotMatch(msg, /\/home\/jane|\/Users\/jane|\/media\/jane/, msg);
      assert.ok(msg.includes(base), msg);
    }
  });
  test("a missing export file is named by its file name only", () => {
    const personal = scratch("gca-hard-personal-");
    const gone = path.join(scratch("gca-hard-export-"), "deep", "direct-messages-group.js");
    fs.writeFileSync(path.join(personal, "config.json"), JSON.stringify({ sourceJs: [gone] }));
    const r = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "build.js")], { env: Object.assign({}, process.env, { GCA_PERSONAL: personal }), encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /BUILD ERROR: .*direct-messages-group\.js/);
    assert.ok(!r.stderr.includes(path.dirname(gone)), r.stderr);
  });
});

describe("media paths in data.js", () => {
  // GCA_PERSONAL (documented in .env.example) puts personal_data somewhere
  // outside the project. Media paths were written relative to the project
  // root ("../../../Users/<name>/…/media/x.png", or "D:/…" on another drive):
  // the server serves that folder as /personal_data/, so every photo was a
  // 404, and data.js carried the layout of the user's folders.
  test("media copied into a personal folder outside the project is addressed as personal_data/media/", () => {
    const personal = scratch("gca-hard-personal-");
    const files = X.writeExport(scratch("gca-hard-export-"));
    const media = path.join(personal, "media");
    fs.mkdirSync(media);
    fs.copyFileSync(path.join(files.media, "9002-AbCdEf.png"), path.join(media, "9002-AbCdEf.png"));
    fs.writeFileSync(path.join(personal, "config.json"), JSON.stringify({ sourceJs: [files.group], headersJs: files.headers, mediaDir: media }));
    const r = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "build.js")], { env: Object.assign({}, process.env, { GCA_PERSONAL: personal }), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const text = fs.readFileSync(path.join(personal, "data.js"), "utf8");
    const data = JSON.parse(text.replace(/^window\.CHAT_DATA\s*=\s*/, "").replace(/;\s*$/, ""));
    const m = data.conversations.flatMap((c) => c.msgs).find((x) => x.i === "9002");
    assert.equal(m.m, "personal_data/media/9002-AbCdEf.png");
    // every media path (not message text, which may say "wait..") stays inside
    const paths = data.conversations.flatMap((c) => c.msgs).flatMap((x) => [x.m].concat((x.mx || []).map((y) => y && y.m))).filter(Boolean);
    assert.ok(paths.length > 0);
    for (const p of paths) {
      assert.ok(!/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(p) && !path.isAbsolute(p) && !/^[A-Za-z]:/.test(p), "no path climbing out of the project in data.js: " + p);
    }
    assert.doesNotMatch(r.stdout, /\.\.[\\/]/, "the log names the folder the same way: " + r.stdout);
  });
});

describe("the build log", () => {
  test("a group name with line breaks or terminal escapes prints as one plain line", () => {
    const personal = scratch("gca-hard-personal-");
    const dir = scratch("gca-hard-export-");
    const group = path.join(dir, "direct-messages-group.js");
    const evil = "Crew\nBUILD ERROR: fake\u001b[2J\u001b]0;title\u0007\r";
    fs.writeFileSync(group, X.ytd("direct_messages_group", "part0", [X.conv("1000000001", [
      X.gmsg(9001, 111, X.T0, "hello"),
      { conversationNameUpdate: { initiatingUserId: "111", name: evil, createdAt: X.iso(X.T0 + 1000) } },
    ])]));
    fs.writeFileSync(path.join(personal, "config.json"), JSON.stringify({ sourceJs: [group] }));
    const r = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "build.js")], { env: Object.assign({}, process.env, { GCA_PERSONAL: personal }), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    // eslint-disable-next-line no-control-regex -- control characters are the point
    assert.doesNotMatch(r.stdout, /[\u0000-\u0008\u000b-\u001f\u007f]/, JSON.stringify(r.stdout));
    assert.doesNotMatch(r.stdout, /^BUILD ERROR/m);
    assert.match(r.stdout, /Crew BUILD ERROR: fake/);
    // the archive itself keeps the name exactly as the export has it
    const data = JSON.parse(fs.readFileSync(path.join(personal, "data.js"), "utf8").replace(/^window\.CHAT_DATA\s*=\s*/, "").replace(/;\s*$/, ""));
    assert.equal(data.conversations[0].title, evil);
  });
});
