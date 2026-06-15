# 💬 Group Chat Archive

A **dependency-free, fully offline** browser for Twitter/X **group chat** (group
DM) exports. Drop in your export, run one build script, and explore years of
group history with fuzzy search, a virtual timeline, a media gallery,
year-in-review "Wrapped" slideshows, leaderboards, and more — no server, no API
keys, no internet. Have several group chats? A picker switches between them.

> **The repo ships with synthetic demo data.** No real messages, names, or media
> are committed. Open `index.html` and you'll see a runnable demo built from
> `data.sample.js`. Point it at your own export to see your real history (kept
> local and `.gitignore`d).

---

## ✨ Features

- **🔎 Fuzzy search** (Fuse.js) with filters: `has:media`, `has:links`,
  `from:name`, `before:/after:YYYY-MM-DD`, exact `"quoted phrases"`, sorting,
  list/grid views, saved searches, and CSV/JSON export.
- **🗂 Multiple group chats** — a conversation picker switches between every
  group in your export. Every view is scoped to the selected group.
- **≡ Virtual timeline** — scrolls 100K+ messages smoothly with a date scrubber
  and jump-to-date.
- **🖼 Gallery** of every photo & video, with a lightbox.
- **🏆 Hall of Fame** — most-reacted messages, podium + leaderboards by year.
- **🎁 Wrapped** — animated year-in-review slideshows.
- **▤ Stats** — per-person activity, word clouds, milestones, busiest hours,
  superlatives.
- **🧵 Threads · ⛓ Chains · ⚔ Battles** — playful analytics & head-to-head.
- **★ Bookmarks**, **⌘K command palette**, **⏳ Time Capsule** ("on this day"),
  **🎲 Random Quote**, context-peek, and quote-card PNG export.
- **🎨 Theming** — black + blue, customizable accent, density, and theme shuffle;
  all preferences saved to `localStorage`.

Everything runs from `file://` — just double-click `index.html`. An optional
`scripts/server.js` is included only if your browser blocks local video over
`file://`.

---

## 🚀 Quick start (demo, zero real data)

```bash
git clone <this-repo>
cd twitter_project
# open the demo straight away:
#   double-click index.html
# or, if your browser blocks local media over file://:
node scripts/server.js      # → http://localhost:8765
```

You'll get a 3-group synthetic demo. Regenerate the demo data anytime:

```bash
node scripts/make_sample.js     # writes data.sample.js + sample_media/
```

---

## 📥 Using your own export

1. Request your archive from X (**Settings → Your account → Download an archive
   of your data**) and unzip it.
2. From the unzipped `data/` folder, copy these into the `exports/` folder here
   (only what you have is needed):
   - `direct-messages-group.js` — group chat conversations (full content)
   - `direct_messages_group_media/` — group chat media
   - *(1:1 DM files and the `*-headers.js` metadata files are ignored)*
3. Build:

   ```bash
   node scripts/build.js
   ```

   `build.js` parses the group export, emits an index of **every group**
   conversation it finds (deduped by message id, media resolved by filename),
   and writes `data.js`. Re-run it any time you add a newer export — history is
   merged, never lost.
4. Open `index.html`. Your real `data.js`, `names.local.js`, media folders, and
   raw exports are all **git-ignored** — they never leave your machine.

### Naming participants

X exports contain only numeric user IDs, so everyone shows as **User 1, User 2,
…** by default. Rename people (and pick colors) in the **People** tab — saved to
`localStorage`. For a permanent local mapping, create a `names.local.js`
(git-ignored) that sets `window.LOCAL_NAMES` / `window.LOCAL_PFPS`.

---

## 📡 Live capture (optional)

X migrated DMs to the encrypted **XChat** UI, and encrypted messages aren't in
data exports. A Tampermonkey userscript (documented in
[`docs/SCRAPER.md`](docs/SCRAPER.md)) can capture new messages live;
`build.js` merges scraped JSON dropped into `exports/`.

---

## 🗃 Data schema

`data.js` / `data.sample.js` define one global:

```js
window.CHAT_DATA = {
  generatedAt: "ISO",
  conversations: [
    {
      id, type: "group", title, participants: [ids], count,
      msgs:  [ { i, s, t, x, u?, m?, k?, r? } ],   // id, sender, time(ms), text, urls, media, kind, reactions
      events:[ { t, type, ... } ]                  // name/join/leave/create
    },
    ...
  ]
}
```

The viewer also accepts the older single-conversation shape
(`{ conversationId, msgs, events }`) for backward compatibility.

---

## 🧱 Project layout

```
index.html          app shell + script loading
src/app.js          all UI logic (vanilla JS, no framework)
src/styles.css      black + blue theme
scripts/build.js    exports → data.js  (multi-group, merge-aware)
scripts/make_sample.js   synthetic demo generator → data.sample.js + sample_media/
scripts/server.js   optional static server (range requests for video)
lib/                Fuse.js + Chart.js (vendored, MIT)
data.sample.js      committed synthetic demo data
sample_media/       committed placeholder media
docs/               architecture + scraper notes
exports/            (git-ignored) drop your raw X exports here
```

Built with [Fuse.js](https://www.fusejs.io/) and
[Chart.js](https://www.chartjs.org/) (both MIT, vendored under `lib/`).

---

## 🔒 Privacy

This repository is designed to be published **without** any private data. Real
messages, media, profile pictures, names, and packaged archives are listed in
[`.gitignore`](.gitignore). The only data committed is the fully synthetic
sample.
