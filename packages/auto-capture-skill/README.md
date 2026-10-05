# auto-capture-skill

Session-end capture skill for the NoSleep Brain. The idea of auto-capturing
at session end is inspired by Nate B. Jones' Open Brain; the skill text is
NoSleep's own. Ships as a plain-text SKILL.md that Claude Code loads.

## Installation

Copy SKILL.md into the Claude Code skills directory for sessions that should
auto-capture:

- User-level: `~/.claude/skills/auto-capture/SKILL.md`
- Project-level: `.claude/skills/auto-capture/SKILL.md`

Or let the NoSleep orchestrator install it automatically when launching a
session (Phase 2+).

## What it does

- Detects session-ending language or the supervision-loop `session_end` event.
- Identifies ACT NOW items and a session summary.
- Calls `capture_thought` on the connected `nosleep-brain-<org>` MCP server.
- Each capture is deduped via `search_thoughts` before writing.

## Related

- [Phase 2 spec](../../docs/plans/brain/12-phase-2-thoughts.md)
- [MCP and API reference](../../docs/plans/brain/04-mcp-and-api.md)
- Inspiration: Nate B. Jones' Open Brain (<https://github.com/NateBJones-Projects/OB1>,
  FSL-1.1-MIT). No code or text is copied from it.
