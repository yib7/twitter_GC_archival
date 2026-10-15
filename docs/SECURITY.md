# Security Policy

## Scope

Group Chat Archive runs entirely on your own machine. The viewer is a static
page that reads a local data file; the optional setup server binds to
`127.0.0.1` only and is meant to be run for the few minutes setup takes, not left
listening. Nothing is sent to any external service, and your real export stays in
the git-ignored `personal_data/` folder. Both pages carry a strict
Content-Security-Policy in a `<meta>` tag (`script-src 'self'`, enforced over
`file://` too). When served, the setup server adds a per-response nonce for
the one config script it injects, and the pages are sent with `X-Frame-Options: DENY` and a `frame-ancestors 'none'` CSP header
(they can't be framed). The server checks:

- the `Host` header of every request against a loopback allowlist (this
  stops DNS rebinding);
- on the routes that change files or open a dialog, an `Origin`/`Referer`
  that must be its own or absent, and a `Sec-Fetch-Site` that, when the
  browser sends it, must be `same-origin` or `none`; the native file pickers
  also need a per-run token only the setup page receives;
- for the archive files themselves (`data.js`, `local.js`,
  `names.local.js`, media and photos under `personal_data/`), the same
  `Sec-Fetch-Site` rule: another site's request gets `403`.

Every reply also carries `Cross-Origin-Resource-Policy: same-origin`, so a
web page on another site can't read the archive through a `<script>`,
`<img>` or `<video>` tag while the server runs (see
[docs/ARCHITECTURE.md](ARCHITECTURE.md)).

The most relevant areas for security reports are therefore:

- HTML/script injection from message content, names, or group titles rendered in
  the viewer.
- Path handling in `scripts/server.js` (static serving and the setup endpoints).
- Gaps in the Host, Origin, `Sec-Fetch-Site`, Cross-Origin-Resource-Policy or
  CSP defenses above: other ways to reach the setup server's file-writing
  endpoints, or to read the archive files, from an unintended origin.

## Reporting a vulnerability

Please report privately through GitHub's
[private vulnerability reporting](https://github.com/yib7/twitter_GC_archival/security/advisories/new)
(the repository's **Security** tab, "Report a vulnerability"). Include the
version or commit, what you did, and what happened.

Expect an initial reply within a few days. Once a fix is out, you are welcome to
be credited.

## Supported versions

This is a single-branch project; fixes land on the default branch. Please test
against the latest commit before reporting.
