# Changelog

All notable changes to this project are recorded here.

## v1.2.0 (2026-07-14)

### Changed

- Restyled the whole interface to X's design language: a three-mode theme
  switch (Light, Dim, and Lights-out, defaulting to Lights-out), X-style
  message bubbles with per-person avatar colors, an X nav rail, and refreshed
  stat tiles, command palette, and setup wizard. Behavior, data, and settings
  are unchanged; this is a visual refresh.
- The theme is now saved under its own `gca.theme` key. The old dark-intensity
  control is replaced by the Light/Dim/Lights-out modes; accent color, font
  size, and density remain customizable.

## v1.1.0 (2026-07-11)

### Added

- Fuzzy search now highlights the matched text in each result, including close
  and typo matches.

### Fixed

- The media Gallery now updates when you switch group chats, instead of keeping
  the first chat's media.
- The Pinned view now gathers bookmarks from every group chat, grouped by
  conversation, instead of showing only the active chat's.
- The `has:media`, `has:links`, and `has:reactions` search operators no longer
  stick to the filter panel after you clear the search box, the same as
  `from:`, `before:`, and `after:`.
- The busiest-day stat shows a formatted date instead of a raw key.
- Plain-text (.txt) exports keep each message on a single line, even when the
  message itself spans several lines.
- The shareable quote-card image uses the person's profile photo when one is
  available.
- Reply-chain detection no longer starts a spurious chain across a long time
  gap.
- Importing settings now asks for confirmation before it replaces your saved
  names, colors, searches, and pins.
- Opening Stats or a profile is faster on large archives, and revisiting Stats
  no longer leaks chart memory.
- Served with `npm start`, the app no longer logs harmless not-found errors for
  optional data files in the browser console.

### Security

- The setup server can no longer be tricked into writing a file outside
  `personal_data/` through a crafted request.
- The setup server no longer crashes on a malformed request path that contains
  control characters.

### Changed

- Refreshed dev dependencies: ESLint 10.7.0.

## v1.0.2 (2026-07-04)

### Security

- Imported settings files can no longer run scripts through profile-photo or
  group-photo values. Photo URLs are validated on import and HTML-escaped
  before rendering.
- The setup server now serves only the app's own files. Private files
  (`config.json`, the raw export under `source/`, `.git/`, and the project
  scripts) are no longer reachable over the local server, including through
  percent-encoded path traversal.

### Fixed

- The setup wizard no longer erases previously saved display names when you
  reopen it and save again. It now prefills your saved names, photos, and
  "this is you" selection, so a second pass edits your setup instead of
  overwriting it.
- Stats, Wrapped, Time Capsule, On This Day, the activity sparkline, and the
  search date filters now bucket messages in the time zone you configured, so
  they agree with the timestamps shown on screen.
- A conversation whose senders are all hidden no longer blanks or crashes the
  app. It shows a friendly empty state, and the app opens to a group that has
  messages.
- Unknown attachment types now render as a file chip instead of a broken video
  tile.
- Search operators such as `from:`, `before:`, and `after:` no longer stick to
  the filter panel after you clear the search box.
- Fun-stat thresholds now match their labels (for example, "5+ in a row"
  triggers at exactly five), and the empty-data help text points at the real
  script paths and the setup wizard.

## v1.0.1 (2026-06-29)

### Fixed

- The UI font now loads from a vendored copy under `lib/fonts/` instead of being
  fetched from Google Fonts, so the app makes no network request and is
  genuinely offline as documented.
- Corrected the README quick start: it cloned into `twitter_GC_archival`, so the
  `cd` step now matches the real folder name.
- The sidebar navigation and buttons now use the theme font instead of the
  browser default.

### Changed

- Documented the `start-setup` double-click launchers as the quickest way to run
  the setup wizard.
- Normalized line endings with `.gitattributes` (`* text=auto`).
- Refreshed dev dependencies: Playwright 1.61.1, ESLint 10.6.0, globals 17.7.0.

## v1.0.0 (2026-06-27)

First public release.

### Added

- Offline viewer for Twitter/X group DM exports. Vanilla JavaScript, runs
  straight from `file://` by double-clicking `index.html`.
- Fuzzy search (Fuse.js) with `has:media`, `has:links`, `from:`, `before:`,
  `after:`, quoted exact phrases, sorting, list/grid views, saved searches, and
  CSV/JSON export.
- Multiple group chats with a conversation picker; every view is scoped to the
  selected group.
- Virtual timeline that scrolls 100K+ messages, with jump-to-date.
- Media gallery with a lightbox, Hall of Fame, Wrapped year-in-review, Stats,
  Threads, Chains, Battles, Time Capsule, Random Quote, and a command palette.
- Black and blue theme with customizable accent and density, saved to
  `localStorage`.
- First-run setup wizard (served) that builds your archive, restores the group
  photo, and walks you through naming everyone.
- Synthetic demo data (`data.sample.js`) so the repository runs with no real
  data committed.

[v1.2.0]: https://github.com/yib7/twitter_GC_archival/releases/tag/v1.2.0
[v1.1.0]: https://github.com/yib7/twitter_GC_archival/releases/tag/v1.1.0
[v1.0.2]: https://github.com/yib7/twitter_GC_archival/releases/tag/v1.0.2
[v1.0.1]: https://github.com/yib7/twitter_GC_archival/releases/tag/v1.0.1
[v1.0.0]: https://github.com/yib7/twitter_GC_archival/releases/tag/v1.0.0
