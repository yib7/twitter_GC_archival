# Credits

Third-party code bundled in this repository. Both libraries are vendored
(committed as minified files under `lib/`) so the app runs fully offline with no
package install at runtime.

## Fuse.js v6.6.2

- License: Apache License 2.0
- Copyright (c) Kiro Risk
- Site: https://www.fusejs.io/
- File: `lib/fuse.min.js` (original copyright header retained)

Powers the fuzzy search and the search filters.

## Chart.js v4.4.1

- License: MIT
- Copyright (c) Chart.js Contributors
- Site: https://www.chartjs.org/
- File: `lib/chart.min.js` (original copyright header retained)

Renders the charts in the Stats view.

## Plus Jakarta Sans

- License: SIL Open Font License 1.1
- Copyright (c) The Plus Jakarta Sans Project Authors (Tokotype)
- Site: https://github.com/tokotype/PlusJakartaSans
- Files: `lib/fonts/plus-jakarta-sans-latin.woff2`,
  `lib/fonts/plus-jakarta-sans-latin-ext.woff2` (latin + latin-ext subsets of
  the variable font, weights 400-700)

The interface typeface, vendored so the app loads it offline instead of fetching
from Google Fonts. The OFL permits this bundling and redistribution.

---

Everything else in this repository (the viewer, the build and setup scripts, the
synthetic sample data, and the placeholder SVG media) is original work released
under the MIT License in [LICENSE](LICENSE).
