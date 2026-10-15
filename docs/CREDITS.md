# Credits

Third-party code bundled in this repository. Both libraries are vendored
(committed as minified files under `lib/`) so the app runs fully offline with no
package install at runtime. Each one keeps its original copyright header, and
its full license text ships next to it in `lib/`.

## Fuse.js v6.6.2

- License: Apache License 2.0, full text in [`lib/LICENSE-fuse.txt`](../lib/LICENSE-fuse.txt)
- Copyright (c) 2022 Kiro Risk
- Site: https://www.fusejs.io/
- File: `lib/fuse.min.js` (original copyright header retained, not modified)
- Upstream: npm package `fuse.js@6.6.2`, file `dist/fuse.min.js`
  (https://cdn.jsdelivr.net/npm/fuse.js@6.6.2/dist/fuse.min.js)
- SHA-256 of the committed file:
  `c57339c3fa16b1d69d9a6b46749a8139ef8d4fc9bbfe48144ff897aa7d4222ec`

Powers the fuzzy search and the search filters.

## Chart.js v4.4.1

- License: MIT, full text in [`lib/LICENSE-chartjs.txt`](../lib/LICENSE-chartjs.txt)
- Copyright (c) Chart.js Contributors
- Site: https://www.chartjs.org/
- File: `lib/chart.min.js` (original copyright header retained, not modified)
- Upstream: npm package `chart.js@4.4.1`, UMD build `dist/chart.umd.js`
  (https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js)
- SHA-256 of the committed file:
  `74401d738dd3e03ee5dfb3b6841210fe2c4ead8a960c4011ca4ba0b78a9fd8f3`

Renders the charts in the Stats view.

### Checking a vendored file

`.gitattributes` marks `lib/*.min.js` as binary (`-text`), so a checkout has the
exact committed bytes on every OS. To check one against the hash above:

```sh
sha256sum lib/fuse.min.js lib/chart.min.js                    # macOS: shasum -a 256 …
# PowerShell: Get-FileHash lib/fuse.min.js -Algorithm SHA256
```

To compare with upstream, download the file from the URL above and hash it the
same way. When a library is upgraded, update its version, upstream URL and hash
here in the same commit.

---

Everything else in this repository (the viewer, the build and setup scripts, the
synthetic sample data, and the placeholder SVG media) is original work released
under the MIT License in [LICENSE](../LICENSE). The two bundled licenses above
(Apache-2.0 and MIT) are permissive and compatible with that release.
