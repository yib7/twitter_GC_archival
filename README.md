# Group Chat Archive

[![CI](https://github.com/yib7/twitter_GC_archival/actions/workflows/ci.yml/badge.svg)](https://github.com/yib7/twitter_GC_archival/actions/workflows/ci.yml)

Browse and search your Twitter/X **group chats**, completely offline. Drop in
your data export, run a one-click setup, and explore years of group history:
fuzzy search, a media gallery, year-in-review "Wrapped" slideshows, leaderboards,
and stats. No server, no accounts, no internet. **Your data never leaves your
computer.**

> Ships with synthetic demo data. Open `index.html` to try it right now. No real
> messages, names, or media are included.

![Group Chat Archive search view with the black + blue theme, running on the
synthetic demo data](docs/screenshot.png)

---

## Try the demo

Double-click **`index.html`**. You'll get a 3-group synthetic demo with every
feature working.

## Use your own chats

1. **Get your data.** On X: **Settings → Your account → Download an archive of
   your data.** Unzip the file when it arrives (it can take a day or two).
2. **Run the setup.** Double-click **`start-setup.cmd`** (Windows) or
   **`start-setup.command`** (Mac/Linux). It opens in your browser. *(One-time:
   install [Node.js](https://nodejs.org), it's free. On Mac/Linux, also run
   `chmod +x start-setup.command` once.)*
3. **Follow the steps.** Point it at your export, give the people in your chats
   names and photos, and click **Finish**.

That's it. From then on, just double-click **`index.html`** whenever you want to
browse. Got a newer export later? Re-run the setup. Your history just grows,
nothing is lost.

## What you can do

- **Search everything:** fuzzy search with filters like `has:media`,
  `from:name`, date ranges, and exact `"phrases"`.
- **Timeline:** scroll years of messages smoothly; jump to any date.
- **Gallery:** every photo and video in one place, with a lightbox.
- **Wrapped:** animated year-in-review slideshows.
- **Hall of Fame:** most-reacted messages and leaderboards.
- **Stats:** who talks most, busiest hours, word clouds, milestones.
- **Multiple group chats:** switch between every group in your export.
- Bookmarks, a Cmd/Ctrl-K command palette, "on this day," and a customizable
  black + blue theme.

## Privacy

Everything stays on your computer. Your real messages, media, and names are never
uploaded and never committed to this repo; they live in a single git-ignored
folder. The only data shipped here is the fully synthetic demo.

---

**Building from this repo or curious how it works?** See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the data schema, build
pipeline, and project layout.
