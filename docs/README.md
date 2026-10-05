# NoSleep Documentation

| File | What it covers |
|------|----------------|
| [api.md](api.md) | All HTTP endpoints, request/response shapes, auth |
| [mcp.md](mcp.md) | The `nosleep` MCP tool — every action with params |
| [setup.md](setup.md) | `npm run setup` wizard (AI routing, brain, NotebookLM, Claude Code, mobile, autostart) and `npm run doctor` |
| [deployment.md](deployment.md) | Install, autostart (macOS/Linux/Windows), watchdog, Tailscale |
| [cli.md](cli.md) | `nosleep` CLI wrapper, slash commands, skills |
| [mobile.md](mobile.md) | iOS/Android app: build, config, discovery, push |
| [opencode.md](opencode.md) | Using NoSleep hooks + auto-capture with OpenCode |
| [architecture.md](architecture.md) | Components, data flow, supervision loop |
| [known-issues.md](known-issues.md) | Usage/context costs, storage growth, memory rot, gaps |
| [runbook.md](runbook.md) | Common failure modes and recovery steps |

Quick orient:
- Server: `packages/server/src/server.ts` on port 3777
- Web dashboard: `packages/web/` on port 5173
- Mobile: `packages/mobile/` (Expo — iOS, Android beta)
- DB: SQLite WAL at `data/nosleep.db`
- API key: `NOSLEEP_API_KEY` in `.env`
