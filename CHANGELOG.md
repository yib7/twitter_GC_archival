# Changelog

All notable changes to this project are recorded here.

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

[v1.0.1]: https://github.com/yib7/twitter_GC_archival/releases/tag/v1.0.1
[v1.0.0]: https://github.com/yib7/twitter_GC_archival/releases/tag/v1.0.0
