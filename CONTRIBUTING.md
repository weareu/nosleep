# Contributing to NoSleep

Thanks for your interest! Bugs, ideas and PRs are welcome. The open problem we
most want help with is **memory rot at scale** (see
[docs/known-issues.md](docs/known-issues.md#4-memory-rot-at-scale-open-problem)).

## Before you start

- For anything bigger than a bug fix, open an issue first so we can agree on
  the approach.
- Every PR needs the **CLA** line in its description (see [CLA.md](CLA.md)).
  You keep your copyright; it lets the project offer a commercial license
  alongside AGPL.

## Development

```bash
node scripts/install.mjs --skip-models
npm run dev:server        # :3777
npm run dev:web           # :5173
```

Checks a PR must pass:

```bash
npx tsc --noEmit -p packages/server      # repeat for the packages you touched
npx vitest run packages/server           # + packages/mobile, scripts as relevant
```

## House rules

- **Tests exercise behaviour.** Call our functions or routes and assert
  results. Don't grep source files in tests, and don't test a dependency's
  own API.
- **Reuse before adding.** Search `packages/server/src/lib` and the existing
  helpers before writing a new one. One code path per capability. MCP, UI and
  hooks call the same function.
- **Org isolation is a hard boundary.** No query may read across orgs unless
  that's its explicit purpose.
- **Errors are visible.** No silent catches on paths that lose data. Log with
  context.
- **Datetimes:** store UTC, render in the viewer's zone, and never send a
  zone-less datetime across an API boundary.
- **No personal data in commits:** paths, IPs, tokens, team ids. Per-developer
  config goes in gitignored `.env` / `.env.local`.
- Commit messages: `type: description` (feat, fix, refactor, docs, test,
  chore, perf, ci).

## Security issues

Don't open a public issue. See [SECURITY.md](SECURITY.md).
