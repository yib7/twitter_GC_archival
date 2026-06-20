# Group Chat Archive

[![CI](https://github.com/yib7/twitter_GC_archival/actions/workflows/ci.yml/badge.svg)](https://github.com/yib7/twitter_GC_archival/actions/workflows/ci.yml)

A local viewer for your Twitter/X group chats. You hand it the group-DM files
from your X data export, it builds a searchable archive, and you read it in your
browser. Everything runs on your own machine. There's no server to host, no
account to sign into, and nothing gets uploaded.

It only handles group chats. One-on-one DMs in your export are ignored.

> The repo ships with fake demo data so you can see what it does before adding
> anything of your own. Open `index.html` and you'll get a sample with three
> groups. No real messages, names, or media are included.

![Group Chat Archive search view with the black + blue theme, running on the
sample demo data](docs/screenshot.png)

---

## Try the demo

Open `index.html` in your browser. You'll get a sample archive built from fake
data, with all the views working, so you can poke around before adding your own.

## Add your own chats

1. **Download your X data.** On X, go to **Settings → Your account → Download an
   archive of your data**. It takes a day or two to arrive. Unzip it.
2. **Start the setup.** Double-click `start-setup.cmd` (Windows) or
   `start-setup.command` (Mac/Linux) to open the setup page in your browser.
   You'll need [Node.js](https://nodejs.org) installed first (it's free; on
   Mac/Linux, run `chmod +x start-setup.command` once).
3. **Point it at your files and build.** From the unzipped export, the setup
   needs three things: the group messages (`direct-messages-group.js`), the group
   headers (`direct-message-group-headers.js`), and the media folder
   (`direct_messages_group_media/`). Browse to each one and hit build.

After that, open `index.html` whenever you want to read your chats. The setup is
only for the first build (or when you add a newer export later).

Everything the setup creates lives in one folder, `personal_data/`, which is
git-ignored. That's where your real data stays.

### Naming people and groups

X only stores numeric IDs, so everyone starts out as "User 1, User 2…". The setup
walks you through naming them, but nothing is locked in once it's done:

- **People.** Give anyone a name, a color, and a profile picture, and mark which
  one is you. Do it during setup, or later in the **People** tab.
- **Groups.** Set each group's name and photo. Editable later under
  **Settings → Group chats**.

### Removing people or groups

You can drop a bot, a stranger, or a dead group out of the archive entirely.
There's a toggle for it in the setup (people and whole group chats both), and
removed people can be brought back before you finish.

### Adding a newer export later

Re-run the setup with a fresh export. It merges with what's already there, so old
messages stick around and nothing gets overwritten.

### Moving to another computer, or sharing

Under **Settings → Export JSON**, you can save all your names, photos, and edits
to a single file. **Import JSON** loads it back on another machine, or lets you
hand a friend the archive with the names already filled in. No setup or server
needed for that part.

### Starting over

The setup page has a **Start over** link that wipes everything you've built so you
can start fresh. It makes you type `RESET` first, and it only touches
`personal_data/`.

## Features

- **Search** with filters like `has:media`, `from:name`, date ranges, and exact
  `"phrases"`.
- **Timeline** that scrolls through years of messages, with jump-to-date.
- **Gallery** of every photo and video, with a lightbox.
- **Wrapped:** year-in-review slideshows.
- **Hall of Fame:** the most-reacted messages, plus leaderboards.
- **Stats:** who posts most, busiest hours, word clouds, milestones.
- **Multiple group chats,** with a picker to switch between them.
- Bookmarks, a Cmd/Ctrl-K command palette, an "on this day" view, and a black +
  blue theme you can adjust.

## Privacy

Everything stays on your computer. Your messages, media, and names are never
uploaded, and they're never committed to this repo. They live in the git-ignored
`personal_data/` folder. The only data in the repo is the fake demo.

---

For the data format, build pipeline, and file layout, see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
