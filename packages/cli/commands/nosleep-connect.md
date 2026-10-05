---
description: "Connect THIS session to NoSleep — monitor + steer it from the dashboard/mobile, no wrapping/spawning. Like Claude's Remote Control, on your own server."
allowed-tools: ["Bash(printf *:.claude/.nosleep-connected)", "Bash(echo *:.claude/.nosleep-connected)", "Bash(rm .claude/.nosleep-connected:*)", "Read(.claude/.nosleep-connected)"]
---

# Connect this session to NoSleep

NoSleep no longer needs to *spawn* a wrapped session to manage one. The
project's hooks already register every session with the NoSleep server
(the up-channel) and the server can queue steering messages back (the
down-channel, drained by the Stop hook between turns). This command opts
THIS already-running session in — it becomes visible on the dashboard /
mobile and steerable from there, with execution staying 100% local. Same
shape as Claude's native Remote Control, but on your own relay (`:3777`).

## Steps

1. Mark the session connected with Bash:
   `printf 'connected' > .claude/.nosleep-connected`
2. Report: "NoSleep CONNECTED. This local session is now tracked on the
   dashboard and steerable from web/mobile (messages you send there are
   injected between turns). Execution stays local. Use /nosleep-pause to
   stop the loop, or delete `.claude/.nosleep-connected` to disconnect."

That's it — the next hook fire registers this session as connected; no
process is spawned and nothing moves to the cloud.
