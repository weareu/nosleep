# Security Policy

NoSleep runs on your machine, can spawn coding agents, and stores your
session history, so security reports are taken seriously.

## Reporting a vulnerability

Report privately via **GitHub → Security → Report a vulnerability** on this
repository. Please don't open a public issue or PR for security problems.

Include what you found, how to reproduce it, and the impact as you see it.
You'll get an acknowledgement within 7 days. Credit is given in the release
notes unless you'd rather stay anonymous.

## Scope

In scope: the server (`packages/server`), MCP gateway, hooks, CLI wrapper,
web dashboard and mobile app in this repo.

Especially interesting:
- Unauthenticated access to the API, WebSocket, or MCP endpoint from a
  non-loopback address
- Anything that lets a network peer launch or steer a session
- Cross-org data leaks
- Secrets written to logs, the Brain archive, or the database in plain text
  where avoidable

Out of scope: running with `NOSLEEP_API_KEY` unset (documented open dev mode),
exposing port 3777 to the public internet against the docs, and issues in
Claude Code, OpenCode or other upstream tools (report those upstream).

## Supported versions

Only the latest `master` is supported.
