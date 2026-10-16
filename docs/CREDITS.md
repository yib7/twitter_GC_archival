# Credits

Third-party code bundled in this repository. Both libraries are vendored
(committed as minified files under `src/vendor/`) so the app runs fully offline with no
package install at runtime. Each one keeps its original copyright header, and
its full license text ships next to it in `src/vendor/`. No fonts, icons or
other third-party assets are bundled: the interface uses the system font stack.

## Fuse.js v6.6.2

- License: Apache License 2.0, full text in [`src/vendor/LICENSE-fuse.txt`](../src/vendor/LICENSE-fuse.txt)
- Copyright (c) 2022 Kiro Risk
- Site: https://www.fusejs.io/
- File: `src/vendor/fuse.min.js` (original copyright header retained, not modified)
- Upstream: npm package `fuse.js@6.6.2`, file `dist/fuse.min.js`
  (https://cdn.jsdelivr.net/npm/fuse.js@6.6.2/dist/fuse.min.js)
- SHA-256 of the committed file:
  `c57339c3fa16b1d69d9a6b46749a8139ef8d4fc9bbfe48144ff897aa7d4222ec`

Powers the fuzzy search and the search filters.

## Chart.js v4.5.1

- License: MIT, full text in [`src/vendor/LICENSE-chartjs.txt`](../src/vendor/LICENSE-chartjs.txt)
- Copyright (c) 2025 Chart.js Contributors (the file header; the bundled license
  text reads "2014-2024")
- Site: https://www.chartjs.org/
- File: `src/vendor/chart.min.js` (original copyright header retained, not modified)
- Upstream: npm package `chart.js@4.5.1`, UMD build `dist/chart.umd.js`
  (https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.js)
- SHA-256 of the committed file:
  `ecc3cd1eeb8c34d2178e3f59fd63ec5a3d84358c11730af0b9958dc886d7652a`

Renders the charts in the Stats view.

### @kurkle/color v0.3.2 (inside Chart.js)

- License: MIT, full text in [`src/vendor/LICENSE-kurkle-color.txt`](../src/vendor/LICENSE-kurkle-color.txt)
- Copyright (c) 2018-2021 Jukka Kurkela (the bundled header reads "(c) 2023")
- Site: https://github.com/kurkle/color
- Not a separate file: Chart.js's UMD build includes it, and the header comment
  naming it is kept in the middle of `src/vendor/chart.min.js`. Its version
  comes from that header; the license text is the `LICENSE.md` of the
  `@kurkle/color@0.3.2` npm package.

Chart.js uses it to parse and mix colours.

### Checking a vendored file

`.gitattributes` marks `src/vendor/*.min.js` as binary (`-text`), so a checkout has the
exact committed bytes on every OS. To check one against the hash above:

```sh
sha256sum src/vendor/fuse.min.js src/vendor/chart.min.js   # macOS: shasum -a 256 …
# PowerShell: Get-FileHash src/vendor/fuse.min.js -Algorithm SHA256
```

To compare with upstream, download the file from the URL above and hash it the
same way. When a library is upgraded, update its version, upstream URL and hash
here in the same commit.

---

Everything else in this repository (the viewer, the build and setup scripts, the
synthetic sample data, and the placeholder SVG media) is original work released
under the MIT License in [LICENSE](../LICENSE). The bundled licenses above
(Apache-2.0 and MIT) are permissive and compatible with that release.
