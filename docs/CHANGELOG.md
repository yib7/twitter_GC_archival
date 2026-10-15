# Changelog

All notable changes to this project are recorded here.

## Unreleased

### Fixes

#### Analytics

- Emoji are counted as whole sequences everywhere: a skin-toned, combined
  (family, flag, keycap) emoji is one emoji, not two or five.
- Stats, Wrapped, Word Battles, the keyword trend and the word cloud share one
  Unicode word tokenizer, so accented, Cyrillic, CJK and apostrophe words
  ("don't") count the same in every view, and the keyword trend counts whole
  words instead of substrings ("man" no longer matches "many").
- Superlatives are fair: frequency awards are rates (per 100 messages or % of
  messages) with a minimum sample, reply awards use the median reply time,
  The Scholar compares everyone at the same number of words, ties are shown,
  and a card is hidden when nobody qualifies or everybody ties. Every card says
  how it is measured, and profile badges come from the same list, so nobody
  gets "The Sailor" for zero swear words.
- Members who never posted (on the roster, reacting or in join/leave events
  only) are counted as people; an ignored member's reactions are dropped too.
- One display name and one colour per person: the People placeholder, Word
  Battles, pinned messages and the quote card match the avatar.
- Month charts and sparklines show silent months as zero instead of joining
  January to September.
- Stats charts follow theme and accent changes live; the keyword trend, the
  hero sparkline dot and the platform bars use theme colours, and every chart
  has a text summary for screen readers.
- "On This Day" picks from every past year, not just the first 20 matches.
- Copy: "1 thread shown", "3 days" chat age (not "0.0 yrs"), "Msgs / active
  day", "<1s" replies; empty Stats panels are hidden, an empty gallery says so,
  and the keyboard help shows ⌘ on Apple devices.

#### Accessibility

- Every keyboard stop shows a visible focus ring, and every clickable card,
  chip, swatch, cloud word, chart bar and message photo is a real button or
  link (Enter and Space work). Avatars stay a mouse/touch shortcut to the
  profile, which the keyboard reaches from People.
- Timeline messages are keyboard stops. Their Reply / Bookmark / Copy toolbar
  appears on focus as well as on hover, and on touch a ⋯ button opens it.
- Icon-only buttons and every input have accessible names; decorative icons
  are hidden from screen readers.
- Toasts are announced through a polite live region.
- The command palette is a proper combobox/listbox: arrow keys move the
  active option for screen readers, and "No matches" is announced.
- The mobile More sheet and onboarding are real modal dialogs: focus moves in,
  Tab is trapped, Escape closes them and focus returns to what opened them.
- Person names, text tokens and on-accent text reach WCAG AA in Light, Dim
  and Lights-out. A new rendered-text audit checks every view in every theme,
  which also fixed faded word-cloud words, superlative definitions, green
  "received" counts in Light, the automatic-colour "A" swatch, avatar
  initials (deeper avatar fills), link chips in your own messages, the
  secondary text on the Stats hero and on every Wrapped slide, and message
  photos' focus ring (now drawn inside the picture).
- The theme switch lives in the sidebar and the More sheet instead of
  floating over content.

#### Importing, building and setup

- Very large exports build: the messages file is read as a stream and the
  archive is written in pieces, so a ~600 MB export no longer fails with a
  "string too long" error. The build's memory limit is sized to the machine.
- A wrong, empty, truncated or group-less file stops the build with one
  plain sentence saying what is wrong and what to pick instead (a file with a
  byte-order mark now builds). The wizard shows that sentence, keeps the
  build log one click away, and doesn't lock your choices after a failure.
- Archives split into `-part1`, `-part2` ... files are imported whole, and a
  missing part is reported.
- Picking the messages and headers files the wrong way round is fixed for
  you. Picking the whole `data` folder, or a folder of `.js` files, as the
  media folder is refused or steered to `direct_messages_group_media`, and only
  group-message media is copied.
- `data.js` and the wizard's files are written atomically, so a crash or a
  full disk can't leave half a file; an unreadable existing archive stops the
  build instead of being silently replaced.
- Members who never posted keep their place when an archive is merged, get a
  card in People ("No messages · joined Mar 2021") and can be named. Messages
  without a valid date are skipped with a warning instead of landing in 1970.
- A message with several photos or videos shows all of them, not just the
  first.
- Removing a group or a person rebuilds the archive without their messages
  and media. Both are kept in `personal_data/.removed/` and come back when
  you un-remove them, even after a merge; only Start over erases them. The
  removal dialog says so instead of calling it permanent.
- Large photos picked for a person or the group are shrunk in the browser
  before upload; every photo is checked before anything is saved, and a
  too-large one is named. A group photo no longer overwrites a person's.
- "This is YOU" and display names can be cleared.
- Paths pasted with quotes, `~/` or backslash-escaped spaces are accepted, and
  a "not found" message shows what a full path looks like.
- Build can't be started twice at once; a failing file dialog says what went
  wrong; the wizard checks there is enough free disk space before copying.
- A save (names, photos, removals) whose upload was still arriving when a
  build started now waits for the build ("try again") instead of running in
  the middle of it, where the build could overwrite what it saved.
- The double-click launchers say plainly when Node.js is missing or older
  than 18, or when they are run from inside the ZIP, instead of showing a raw
  error. The launchers and the server need Node 18 or newer.
- A reopened wizard shows the saved group name and photo, and saving no
  longer blanks a group name saved earlier.
- A person has the same avatar colour in the wizard as in the archive.
- The wizard fits a 390px phone without sideways scrolling, and preview
  warnings are readable on the Light theme.
- The server reads the built archive as a stream for the wizard's status,
  people and removal steps, so a big archive doesn't run it out of memory.
- A build stops with a plain sentence when `data.js` is missing but its
  backup or an unfinished save is beside it, instead of replacing that
  history with the export alone. A first save blocked by another program
  says so correctly.
- Backup folders left by a killed build are cleared once a later build
  succeeds; restoring a removed person's media copies only their messages'
  media.
- The launcher's server no longer stops under a hidden or sleeping tab: it
  exits about 20 seconds after the last open page is closed. If the server has
  stopped, the page says so and how to restart it.

#### Viewer and demo

- The Stats hero's secondary text is really dimmed in all three themes; its
  contrast tweak used to refer to itself and was silently dropped.
- The optional data-file probes in `index.html` no longer carry `onerror`
  handlers the Content-Security-Policy blocked anyway; a missing optional
  file still only logs a not-found line over `file://`.
- The demo data spans about 18 months (January 2024 to July 2025) across
  three group chats, with renames, joins and a leave, reactions, links,
  several photos on one message and right-to-left and emoji text. It is
  generated the same way on every run, and its placeholder media are all
  labelled as photos (one used to be an image file tagged as a video).

#### Tooling

- `package.json` `engines` is now `^22.13.0 || >=24`, the versions the
  dev tooling (ESLint 10, Playwright, `node --test` with a glob) really needs.
  The app itself still runs on Node 18.
- The 100k-message performance test runs after the rest of the suite, on one
  worker, so its timings don't compete with other tests.
- CI fails when `data.sample.js` or `sample_media/` differ from what the
  generator makes.

### Features

#### Dates and time zones

- Dates now follow your browser's own timezone by default instead of UTC.
  A saved "UTC" (the old default) moves to your browser's zone once. Earlier
  versions saved a UTC you picked the same way as the default, so that one
  moves too: pick UTC again in Settings to keep it. Any other zone you picked
  is kept, and so is a zone (UTC included) you pick from now on. Settings
  now lists every timezone your browser knows, with a filter box.
- An invalid saved timezone now falls back to the browser's zone (it used to
  fall back to UTC).

#### Search

- Search shows exact matches first. Typo-tolerant "close matches" appear
  automatically when nothing matches exactly, and a "+ Show close matches"
  link adds them on demand.
- An "All chats" switch in Search looks through every group chat at once. The
  results are grouped by chat, with this chat first. Each group's header shows
  the chat's name and how many messages matched, plus a "Search only <chat>"
  button that runs the same search in that chat. Group chats you removed and
  people you ignored stay out. The address remembers the switch (`&s=all`)
  but never your search text. All chats shows exact matches only.
- The command palette (Cmd/Ctrl-K) searches messages too. After the commands
  it lists the five newest messages in this chat that match, each with a
  highlighted snippet, the sender and the date. The last row reads "See all
  in Search" and opens the Search view with your query. The palette
  understands the same operators as Search.
- Search operators show as chips under the box ("From Ann", "Has photo",
  "Since Jun 2021", "Not "spoiler""). Click a chip, or press Backspace /
  Delete on it, to remove that operator from your query.
- Typing `from:` opens a list of people to pick from. It matches display
  names and their aliases (the name set in setup, a name set in People, and
  "User N"). Ignored people never appear. Use the arrow keys and Enter / Tab
  to pick a name.
- New operators: `has:photo`, `has:video`, `has:file` and `is:pinned`
  (bookmarked messages). `has:link` and `has:reacts` join `has:media`.
- Keyboard navigation in the results. Once a result has focus, j / ↓ and
  k / ↑ move to the next or previous result, Enter opens it, c shows its
  context and b bookmarks it. The keys do nothing while you type in the box,
  and a screen reader hears "Result n of N" once you stop.
- Operators work with accented and non-Latin names and words (`from:Zoë`,
  `-café`). An operator no longer needs a space after it, and an operator
  you're still typing waits until you finish. `from:` matches a full name, the
  start of a name or word, or any part of a name, and an ambiguous `from:`
  you're still typing shows suggestions instead of guessing. A `from:` that
  names nobody says "No one named …" instead of being ignored.
- Quoted phrases stay exact in Fuzzy mode: a close match must still contain
  every `"quoted phrase"` word for word.
- Search finds the text a link shows: its full and display URLs, not just
  the t.co short link. The word cloud and the keyword statistics are
  unchanged.
- The Timeline's "Search" button opens the Search view with the box focused,
  the same as `/`. The command palette is still Cmd/Ctrl-K.

#### Navigation

- The address bar now tracks where you are, as ids only (`#v=view&c=conversation`,
  plus the message a Timeline jump landed on). Your search text is never put in
  the address or its history entry's URL: Back, Forward and reload restore it
  from the browser's per-tab history state instead. Back and Forward
  walk your view switches, conversation switches and jumps; after jumping from
  a search result, Back returns to the result list at the same scroll
  position. Links work from `file://` too. A link into a hidden or missing
  conversation or message says so and falls back; anything malformed in the
  address is ignored.
- "Link" on a message copies an ids-only link that opens that message. Opened
  from a local file, it copies just the `#…` part (so your folder path isn't
  shared) and says to paste it at the end of the archive's address.
- The Timeline opens at the newest message and remembers where you were
  reading in each conversation (on this device). A "Latest" button appears
  when you scroll up, and Home / End jump to the oldest / newest message.
- "Jump to date" opens a calendar: year and month strips with message-volume
  bars, and a month heatmap of days you can browse with the arrow keys
  (Page Up / Down by month, Enter jumps). It is also in the command palette as
  "Browse by date (calendar)" and, on phones, in the More sheet.
- Jumping to a date accepts natural forms ("June 2021", "Jan 7 2024", "2021"),
  rejects dates that don't exist ("No such date: 2023-02-30") instead of
  rolling them over, reads slashed dates month first (a day-first 13/01/2024
  says to use 2024-01-13 or Jan 13 2024 instead), and says honestly where it landed when the date is
  before the first message, after the last, or on a day with no messages.
- The Timeline no longer opens at the oldest message (it opens at your last
  reading position, else the newest). "Reset customization" keeps the saved
  reading positions.
- `before:` / `after:` accept a month (`2021-06`), a year (`2024`) or a quoted
  natural date, and are documented as inclusive of the whole period they
  name. An impossible date is ignored with a note in the result line.

#### Wrapped and sharing

- Wrapped plays like a story: tap the left or right third of a slide (or
  swipe) to move, press and hold to pause, and a segmented progress bar
  replaces the dots and fits a phone screen. Slides advance on their own
  (with a Pause/Play button) unless you prefer reduced motion; screen readers
  hear which slide you moved to, but not every automatic step. Arrow keys and
  Space move the story only when focus isn't on a control inside it.
- Share any message, Hall of Fame entry or Wrapped slide as an image. One
  renderer draws all three in your current theme and accent. The Share
  dialog previews the card, saves a PNG, and can copy it to the clipboard
  where the browser supports it. Nothing is uploaded and file names only
  carry ids and years. This replaces the old "Quote" PNG export.
- "Hide names & photos" in the Share dialog swaps every name, alias, @handle
  and photo for "Person A/B/C" and plain discs, in titles and rankings too.
  It is on by default for Wrapped slides that rank people, and your last
  choice is remembered on this device. A name that is also a common word
  (a lowercase "will") may stay in the message text, so check the preview.
- Wrapped backdrops and highlights are mixed from your accent colour in all
  three themes instead of fixed violet/amber washes.
- The softer text tweaks made for contrast now apply only to Light and Dim;
  Lights-out keeps its original colours. The Wrapped secondary text was
  silently ignoring its contrast tweak (a CSS variable referring to itself)
  and now reads at full contrast.

#### Importing and setup

- Pick the unzipped archive folder (or any file in it) instead of three
  files: the wizard reads the archive's `data/manifest.js` to find every
  messages part, the headers and the media folder, and falls back to finding
  them by name. Paths in the manifest are never followed outside the folder.
- "Check export" shows a preview before anything is written: group chats,
  message counts per group, dates, people, photos & videos, and plain
  warnings (missing part files, swapped files, 1:1 DMs left out, media that
  belongs to no message, unreadable dates, nothing to import).
- "Add a newer export": a built archive can take a newer download without
  Start over. The preview shows what the archive already has and what the
  export adds; merging keeps every message of the current archive, adds the
  new ones once each, keeps names, photos, group names, "me" and removed
  people, and leaves the pre-merge archive in `data.js.bak`.
- A progress bar shows the photo & video copy during a build; media already
  in the archive isn't copied again.
- Removed people's and group chats' messages are kept aside in
  `personal_data/.removed/messages.js`, so un-removing brings them back even
  after merging a newer export that no longer has them. An archive whose
  removals were made before this is rebuilt once before its first merge, so
  they are kept aside too; a merge that fails puts them back as they were.
- Merging an export older than the archive asks first, and keeps the
  archive's newer copies of messages (edits); reactions from both are kept.
  Re-adding an export the archive already has asks to "re-add anyway".
  An export with no group messages can't be merged.
- Media copies never replace a file the archive already has and never leave
  a half-copied file behind; a manifest that doesn't list every part file
  no longer hides the unlisted parts.

#### Mobile and UX

- On phones, search filters collapse into a "Filters" sheet with an active-
  filter badge, and the search box no longer autofocuses (no surprise
  keyboard). Tapping outside the sheet only closes it, and widening the
  window turns it back into the inline filter bar.
- On touch screens the ⋯ on your own messages sits on the left, clear of
  your avatar.
- On touch screens, controls have 44px targets.
- Settings rows and Stats grids reflow to one column on narrow screens
  instead of overflowing.
- Empty states say what to do next and offer a button (Clear search &
  filters, Switch to List, Open Timeline, Search messages).
- Gallery has the standard page header with an item count; the lightbox has
  one top toolbar with "n / N", Bookmark, Download and Close.
- Word Battles keeps the words you add when you change the people and across
  reloads. Duplicates are refused, each custom word can be removed, Reset
  keeps them, and Import/Export treats them as their own section. A word
  over 40 characters, or the 31st word pushing out the oldest, says so.
- Opening the Timeline no longer flashes message 0 before your place, and the
  sticky day pill is translucent and no longer blocks taps on media under it.
- Time Capsule sizes itself by layout, so it no longer ends up as a scroller
  inside the page scroller.

#### Performance

- On a 100,000-message archive, opening Stats or switching conversations with
  Stats open is roughly 8x faster (about 1.2 s down to about 130 ms): the
  overview paints first and the heavy sections fill in right after, and every
  analytics view shares one cached per-conversation time index.
- Fuzzy searches narrow the archive with a prefilter before scoring, so a
  typo'd keystroke stays under about 60 ms on 100k messages with identical
  results.
- The search result list keeps only the pages near the viewport rendered, so
  scrolling through a huge result set no longer grows the page without bound.
  Infinite scroll is unchanged.

### Security

- While the local server runs, another website can no longer read your
  archive. Before, any page you visited could load `personal_data/data.js`
  (or `local.js`) with a `<script>` tag and read every message and name. Now
  every reply carries `Cross-Origin-Resource-Policy: same-origin`, and the
  archive, names, media and photos are refused (`403`) when the browser says
  another site asked for them.
- Build, save, removal preview and Start over are refused when the browser
  says another site sent the request (`Sec-Fetch-Site`), as the file pickers
  already were.
- The native file pickers require a per-session token and a same-origin
  request, so another website can't open them.
- Pages are sent with `X-Frame-Options: DENY` and `frame-ancestors 'none'`, so
  they can't be framed by another site.

### Docs

- ARCHITECTURE lists every setup-server endpoint, the real `config.json` and
  `local.js` shapes, the script load order, the CSP and a Testing section;
  README describes the Node versions, project layout and data schema as they
  are, with new screenshots and a new walkthrough recorded from the demo data.
- `.env.example` lists only the variables a user may set (`GCA_PORT`,
  `GCA_PERSONAL`, `GCA_DEBUG`); the test switches are documented in
  ARCHITECTURE.
- The vendored Fuse.js and Chart.js ship with their license texts, and
  docs/CREDITS.md records where they come from and their SHA-256 hashes.

## v1.4.0 (2026-08-25)

### Added

- Custom-emoji DM reactions now show the actual emoji instead of a generic
  placeholder.
- Two Stats superlatives that never used to appear — "The Laugh Track" and
  "The Hater" — now show up (they were comparing reaction keys to the wrong
  values and always scored zero).

### Changed

- Internal cleanup with no behavior change: the Stats superlatives are now
  data-driven, shared constants live in a single module, and a redundant
  per-render count was removed.
- CI now runs the test suite on Windows, macOS, and Linux (previously Linux
  only), plus a manual dispatch trigger. Refreshed dev dependencies
  (Playwright, ESLint, globals) including a transitive audit-advisory fix; no
  runtime dependency is affected, since the project ships none.

### Fixed

- The timeline now renders system events (created the conversation, named the
  group, joins, and leaves) that happen before the first message or in a quiet
  stretch between screens, instead of silently dropping them.
- A corrupt or ported timezone setting no longer stops the app from starting —
  it falls back to UTC.
- Copying a message now reports "Copy failed" instead of a false "Copied" when
  the clipboard is unavailable or denied.
- The setup wizard no longer silently overwrites media files that share a
  filename across different folders, and stays responsive while copying large
  media libraries.

### Security

- The setup server now rejects requests with a foreign Host header or a
  cross-origin Origin/Referer, closing a cross-site path to the destructive
  reset endpoint and a DNS-rebinding exposure.
- Added a Content-Security-Policy (a `<meta>` tag, so it also applies over
  `file://`) as a second line of defense behind the existing output escaping.
- The identity endpoint (`POST /api/identity`) no longer lets a `__proto__`
  key in the request body repoint an internal object's prototype
  (prototype-pollution hardening; the exposure was narrow, since the same
  request already controls every real key).

## v1.3.0 (2026-07-16)

### Added

- The timeline gained sticky date dividers, richer link previews, an "On this
  day" toast, and a toolbar with the message count and a jump-to-date control.
- Stats count up on load and show a messages-per-month sparkline above the tiles.
- Wrapped is now a story-mode recap: step through segmented slides with themed
  backdrops, animated counters, and per-person bars.
- The command palette groups results by type (views, actions, theme, people,
  saved searches, dates), highlights the matched text, and shows avatars.
- A layout for narrow screens: a top bar with the conversation picker, a
  five-tab bottom bar, and a "More" sheet for the remaining views.

### Changed

- The setup wizard has smoother step transitions, a success animation, and a
  summary of the archive it built.
- Motion honors the system "reduce motion" setting and pauses while the tab is
  hidden.

### Fixed

- The setup server prints a clear message when its port is already in use,
  instead of a raw stack trace.
- Screen readers now announce every form control and gallery image: the settings
  options, the Word Battles person pickers, the photo uploaders, and the media
  grid all carry proper labels.

### Security

- The setup wizard escapes server error text before showing it, closing a
  reflected-markup gap.

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

[v1.3.0]: https://github.com/yib7/twitter_GC_archival/releases/tag/v1.3.0
[v1.2.0]: https://github.com/yib7/twitter_GC_archival/releases/tag/v1.2.0
[v1.1.0]: https://github.com/yib7/twitter_GC_archival/releases/tag/v1.1.0
[v1.0.2]: https://github.com/yib7/twitter_GC_archival/releases/tag/v1.0.2
[v1.0.1]: https://github.com/yib7/twitter_GC_archival/releases/tag/v1.0.1
[v1.0.0]: https://github.com/yib7/twitter_GC_archival/releases/tag/v1.0.0
