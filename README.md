# Group Chat Archive

A **dependency-free, fully offline** browser for Twitter/X **group chat** (group
DM) exports. Drop in your export, run one build script, and explore years of
group history with fuzzy search, a virtual timeline, a media gallery,
year-in-review "Wrapped" slideshows, leaderboards, and more — no server, no API
keys, no internet. Have several group chats? A picker switches between them.

> **The repo ships with synthetic demo data.** No real messages, names, or media
> are committed. Open `index.html` and you'll see a runnable demo built from
> `data.sample.js`. Point it at your own export to see your real history (kept
> local and `.gitignore`d).

![Group Chat Archive — search view with the black + blue theme, running on the
synthetic demo data](docs/screenshot.png)

---

## Features

- **Fuzzy search** (Fuse.js) with filters: `has:media`, `has:links`,
  `from:name`, `before:/after:YYYY-MM-DD`, exact `"quoted phrases"`, sorting,
  list/grid views, saved searches, and CSV/JSON export.
- **Multiple group chats** — a conversation picker switches between every
  group in your export. Every view is scoped to the selected group.
- **Virtual timeline** — scrolls 100K+ messages smoothly, with jump-to-date
  from the Cmd/Ctrl-K command palette.
- **Gallery** of every photo & video, with a lightbox.
- **Hall of Fame** — most-reacted messages, podium + leaderboards by year.
- **Wrapped** — animated year-in-review slideshows.
- **Stats** — per-person activity, word clouds, milestones, busiest hours,
  superlatives.
- **Threads, Chains, Battles** — playful analytics & head-to-head.
- **Bookmarks**, a **Cmd/Ctrl-K command palette**, **Time Capsule** ("on this
  day"), **Random Quote**, context-peek, and quote-card PNG export.
- **Theming** — black + blue, customizable accent, density, and theme shuffle;
  all preferences saved to `localStorage`.

Everything runs from `file://` — just double-click `index.html`. The included
`scripts/server.js` is needed only for the first-run **setup wizard**
(`setup.html`) or if your browser blocks local video over `file://`.

Run smoke checks after installing dev dependencies:

```bash
npm install
npm run test:smoke
```

---

## Quick start (demo, zero real data)

```bash
git clone <this-repo>
cd twitter_project
# open the demo straight away:
#   double-click index.html
# or, if your browser blocks local media over file://:
node scripts/server.js      # -> http://localhost:8765
```

You'll get a 3-group synthetic demo. Regenerate the demo data anytime:

```bash
node scripts/make_sample.js     # writes data.sample.js + sample_media/
```

---

## Using your own export

Request your archive from X (**Settings -> Your account -> Download an archive of
your data**) and unzip it. The group chat archive needs all three of these:

- `direct-messages-group.js` — group chat conversations (full message content)
- `direct-message-group-headers.js` — group metadata (completes the participant
  roster and join/leave/name events)
- `direct_messages_group_media/` — group chat media (photos & videos)

*(1:1 DM files are ignored — this tool is group-chats only.)*

### Setup wizard

The wizard writes config, copies your files and media, runs the build, restores
the group photo, and walks you through naming everyone — all from the browser. It
needs the local server (writing files needs Node):

```bash
node scripts/server.js                 # -> http://localhost:8765
# then open  http://localhost:8765/setup.html
```

1. **Source** — click **Browse…** to pick your `direct-messages-group.js`, your
   `direct-message-group-headers.js`, and your media folder (all three required;
   native file dialogs on Windows), then **Build**. Once built, the source files
   **lock** so you can't accidentally rebuild with mismatched files — use *Start
   over* to change them.
2. **Group** *(optional)* — set the group name + photo (becomes the sidebar mark).
   With several group chats, a **group selector** lets you set each one's name and
   photo independently. You can also **remove an entire group chat** here (a dead
   group, a stranger group) with the *Remove this group chat* toggle — it's
   excluded from the archive, just like removing a person.
3. **People** *(optional)* — scoped to **one group at a time** (switch with the
   same group selector), so you only name the people in the chat you care about.
   Each participant card shows sample messages and a few pieces of media they
   shared (Twitter/X links excluded — they don't help you tell people apart; click
   a thumbnail to enlarge it). Name them, add a photo, and mark which one is
   **you**. **Remove** anyone you'd rather not keep (a bot, a stranger) — they're
   dropped from the archive (undo-able before you finish). *(Names & photos are
   keyed by user id, so the same person keeps their name across every group.)*
4. **Finish** — saves everything and links to the archive.

Everything the wizard writes lands in one git-ignored folder, **`personal_data/`**
(`config.json`, the built `data.js`, `local.js`, the copied raw export under
`source/`, copied `media/`, and `pfps/`). After setup, daily use is just
double-clicking `index.html`.

> **Adding a newer export later?** Just re-run the wizard. The build is
> merge-aware, so your history accumulates and is never lost.

> **Want a clean slate?** The wizard's **Start over** link (bottom of the page)
> erases everything in `personal_data/` — you type `RESET` to confirm — so you can
> rebuild from scratch. It only ever touches `personal_data/`; a backup kept in a
> separate folder is left alone.

### Naming participants

X exports contain only numeric user IDs, so everyone shows as **User 1, User 2,
…** by default. The setup wizard (above) is the easiest way to name everyone. You
can always edit later in the **People** tab — rename, pick a color, upload a
profile picture, and mark "This is me" — all saved to `localStorage` (works from
`file://`, no server). **Group** names and photos are editable the same way under
**Settings → Group chats** (each group chat independently), so nothing set in the
wizard is permanent. For a permanent local mapping you can also hand-edit
`personal_data/local.js` (`window.LOCAL_NAMES` / `LOCAL_PFPS` / `LOCAL_ME` /
`LOCAL_GC`).

To move your setup to another machine — or hand a friend the archive with every
name already filled in — use **Settings → Export JSON**. It folds the wizard's
identity (names, photos, "you", per-group names/photos, and removed users/groups)
together with your in-app edits into one portable file that **Import JSON**
restores, no wizard or server needed.

---

## Data schema

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

Private builds can omit known bad/export-only users with the **Remove** button on
the wizard's People step (it writes `window.LOCAL_IGNORED_USERS` to
`personal_data/local.js` and records the ids in `config.json` so future rebuilds
drop them too). You can also set `ignoredUsers: ["user-id"]` in
`personal_data/config.json` by hand before a build, or `window.LOCAL_IGNORED_USERS`
in a gitignored local override.

Whole group chats can be removed the same way — the **Remove this group chat**
toggle on the Group step writes `window.LOCAL_IGNORED_GROUPS` and
`config.ignoredGroups`, so the conversation is dropped from the build and hidden
in the viewer.

---

## Project layout

```
index.html          app shell + script loading
setup.html          first-run setup wizard (served)
src/app.js          all UI logic (vanilla JS, no framework)
src/styles.css      black + blue theme
src/setup.js        setup-wizard logic
src/setup.css       setup-wizard styles
scripts/build.js    config -> personal_data/data.js  (wizard-driven, merge-aware)
scripts/make_sample.js   synthetic demo generator -> data.sample.js + sample_media/
scripts/server.js   static server + setup-wizard API (range requests for video)
lib/                Fuse.js + Chart.js (vendored, MIT)
data.sample.js      committed synthetic demo data
sample_media/       committed placeholder media
docs/               architecture notes
personal_data/      (git-ignored) wizard output: config.json, data.js, local.js,
                    source/, media/, pfps/ — all your real, private data in one place
```

Built with [Fuse.js](https://www.fusejs.io/) and
[Chart.js](https://www.chartjs.org/) (both MIT, vendored under `lib/`).

---

## Privacy

This repository is designed to be published **without** any private data. Real
messages, media, profile pictures, names, and packaged archives are listed in
[`.gitignore`](.gitignore). The only data committed is the fully synthetic
sample.
