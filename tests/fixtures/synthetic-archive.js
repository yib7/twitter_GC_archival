// Deterministic synthetic archive generator (SP3 perf spec). NEVER real data:
// every id, name and line below is made up, and the output is flagged __sample.
//
// `generateArchive` is SELF-CONTAINED on purpose (no closures over module
// scope): the perf spec injects `"(" + generateArchive + ")(opts)"` as the
// body of data.sample.js, so 100k messages are generated in the page itself
// instead of shipping a ~20 MB JSON payload through page.route().
//
//   generateArchive({ main: 100000, side: 20000, seed: 4242 })
//     -> { __sample: true, conversations: [ "Perf Big" (main msgs, 7 people,
//          2019-03 → 2024-09), "Perf Side" (side msgs, 4 people) ] }
//
// Manual use (writes a data.sample.js-shaped file to stdout, e.g. for the
// scratch perf harness): node tests/fixtures/synthetic-archive.js 100000 > /tmp/perf-data.js
function generateArchive(opts) {
  opts = opts || {};
  const N_MAIN = opts.main == null ? 100000 : opts.main;
  const N_SIDE = opts.side == null ? 20000 : opts.side;
  let seed = opts.seed == null ? 4242 : opts.seed;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const chance = (p) => rnd() < p;
  const LINES = ["yo did everyone see that", "lmaooo no way", "ok that's actually wild", "anyone free this weekend?", "i'm down for whatever", "let's gooo", "brb getting food", "wait what happened", "send the link", "that's hilarious", "fr fr", "i can't with this chat", "good morning", "who's hyped for the game", "this is the best gc", "real talk though", "imagine missing that", "10/10 would recommend", "be there in 5", "did the homework btw", "new pfp who dis", "stop it", "valid point", "we should do this more often", "absolute cinema", "no thoughts head empty", "the vibes are immaculate", "okay but hear me out", "this aged well", "happy friday everyone", "running late sorry", "let's plan something", "lol 😂", "THIS IS SO GOOD", "thanks guys 🙏"];
  const LONGER = ["honestly this group chat has been carrying my whole week, you guys are the best", "okay so the plan is: meet at noon, grab lunch, then we figure out the rest as we go", "i was thinking we could do a movie night this weekend if everyone's around", "remember when we stayed up until 4am arguing about the most random stuff, good times"];
  const REACTS = ["funny", "like", "agree", "disagree", "excited", "surprised"];
  let msgId = 1e6;
  function convo(id, title, parts, n, start, end) {
    const step = (end - start) / Math.max(1, n);
    let t = start;
    const msgs = [];
    for (let k = 0; k < n; k++) {
      t += step * (0.2 + rnd() * 1.6);
      const s = pick(parts);
      const r = { i: String(++msgId), s, t: Math.round(t), x: chance(0.15) ? pick(LONGER) : pick(LINES) };
      if (chance(0.03)) {
        const url = "https://example.com/p/" + k;
        r.x += " " + url;
        r.u = [{ s: url, e: url }];
      }
      if (chance(0.03)) { r.m = "sample_media/photo-1.svg"; r.k = "img"; }
      if (chance(0.2)) {
        const o = parts.filter((p) => p !== s);
        r.r = [{ k: pick(REACTS), s: pick(o) }];
        if (chance(0.3)) r.r.push({ k: pick(REACTS), s: pick(o) });
      }
      msgs.push(r);
    }
    return { id, type: "group", title, participants: parts.slice(), count: n, msgs, events: [{ t: start, type: "create", s: parts[0] }] };
  }
  const P = ["2001", "2002", "2003", "2004", "2005", "2006", "2007"];
  const conversations = [convo("910000000000000001", "Perf Big", P, N_MAIN, Date.UTC(2019, 2, 1), Date.UTC(2024, 8, 1))];
  if (N_SIDE > 0) conversations.push(convo("910000000000000002", "Perf Side", P.slice(0, 4), N_SIDE, Date.UTC(2021, 0, 1), Date.UTC(2024, 5, 1)));
  return { generatedAt: "2024-09-01T00:00:00.000Z", __sample: true, conversations };
}

// data.sample.js-shaped script body that generates the archive in the page.
function archiveScript(opts) {
  return "window.CHAT_DATA = (" + generateArchive.toString() + ")(" + JSON.stringify(opts || {}) + ");";
}

module.exports = { generateArchive, archiveScript };

if (require.main === module) {
  const main = +(process.argv[2] || 100000);
  const side = process.argv[3] == null ? 20000 : +process.argv[3];
  process.stdout.write("window.CHAT_DATA = " + JSON.stringify(generateArchive({ main, side })) + ";\n");
}
