# Security Policy

## Scope

Group Chat Archive runs entirely on your own machine. The viewer is a static
page that reads a local data file; the optional setup server binds to
`127.0.0.1` only and is meant to be run for the few minutes setup takes, not left
listening. The double-click launchers' server exits about 20 seconds after the
last open page closes; `npm start` keeps running until you stop it. Nothing is
sent to any external service, and your real export stays in the git-ignored
`personal_data/` folder. Both pages carry a strict Content-Security-Policy in a
`<meta>` tag (`script-src 'self'`, `form-action 'none'`, enforced over `file://`
too). When served, the setup server adds a per-response nonce to that
`script-src` for the one config script it injects (it holds the server's own
address; no other inline script is allowed), and sends the pages with
`X-Frame-Options: DENY` and a `frame-ancestors 'none'` CSP header (they can't
be framed). The server checks:

- the `Host` header of every request against a loopback allowlist (this
  stops DNS rebinding);
- on the routes that change files or open a dialog, an `Origin`/`Referer`
  that must be its own or absent, and a `Sec-Fetch-Site` that, when the
  browser sends it, must be `same-origin` or `none`; the native file pickers
  also need a per-run token only the setup page receives;
- for every other `/api/` route and for the archive files themselves
  (`data.js`, `local.js`, `names.local.js`, media and photos under
  `personal_data/`), the same `Sec-Fetch-Site` rule: another site's request
  gets `403`. The `/api/` routes also refuse an `Origin` or `Referer` that
  names another site, for browsers that don't send `Sec-Fetch-Site`.

Every reply also carries `Cross-Origin-Resource-Policy: same-origin`, so a
web page on another site can't read the archive through a `<script>`,
`<img>` or `<video>` tag while the server runs, plus
`X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin` (see
[docs/ARCHITECTURE.md](ARCHITECTURE.md)).

The most relevant areas for security reports are therefore:

- HTML/script injection from message content, names, or group titles rendered in
  the viewer.
- Path handling in `scripts/server.js` (static serving and the setup endpoints).
- Gaps in the Host, Origin, `Sec-Fetch-Site`, Cross-Origin-Resource-Policy or
  CSP defenses above: other ways to reach the setup server's file-writing
  endpoints, or to read the archive files, from an unintended origin.

## Reporting a vulnerability

Please report privately. Open the repository's **Security** tab and choose
["Report a vulnerability"](https://github.com/yib7/twitter_GC_archival/security/advisories/new)
(GitHub's private vulnerability reporting). Include the version or commit, what
you did, and what happened.

If that button isn't there (the repository owner has to switch the feature on),
don't post the details publicly. Open an issue titled "Security contact
request" that says only that you have a security report, with no technical
detail, and a private channel will be arranged from there.

Expect an initial reply within a few days. Once a fix is out, you are welcome to
be credited.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.5.x   | Yes |
| 1.4.x and earlier | No. Update to the latest 1.5.x. |

This is a single-branch project; fixes land on the default branch and ship in
the next 1.5.x release. Please test against the latest commit before reporting.
