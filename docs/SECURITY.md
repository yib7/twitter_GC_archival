# Security Policy

## Scope

Group Chat Archive runs entirely on your own machine. The viewer is a static
page that reads a local data file; the optional setup server binds to
`127.0.0.1` only and is meant to be run for the few minutes setup takes, not left
listening. Nothing is sent to any external service, and your real export stays in
the git-ignored `personal_data/` folder. The setup server's pages
carry a strict Content-Security-Policy (`<meta>`, with a per-response nonce) and
are sent with `X-Frame-Options: DENY` and a `frame-ancestors 'none'` CSP header
(they can't be framed). It validates every request's Host/Origin against
a loopback allowlist, requires a per-run token for the native file pickers, rejecting cross-origin and DNS-rebinding attempts (see
[docs/ARCHITECTURE.md](ARCHITECTURE.md)).

The most relevant areas for security reports are therefore:

- HTML/script injection from message content, names, or group titles rendered in
  the viewer.
- Path handling in `scripts/server.js` (static serving and the setup endpoints).
- Gaps in the Host/Origin/CSP defenses above, or other ways to reach the setup
  server's file-writing endpoints from an unintended origin.

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
