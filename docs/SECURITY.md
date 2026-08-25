# Security Policy

## Scope

Group Chat Archive runs entirely on your own machine. The viewer is a static
page that reads a local data file; the optional setup server binds to
`127.0.0.1` only and is meant to be run for the few minutes setup takes, not left
listening. Nothing is sent to any external service, and your real export stays in
the git-ignored `personal_data/` folder.

The most relevant areas for security reports are therefore:

- HTML/script injection from message content, names, or group titles rendered in
  the viewer.
- Path handling in `scripts/server.js` (static serving and the setup endpoints).

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
