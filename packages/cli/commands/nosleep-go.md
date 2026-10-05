---
description: "Enable NoSleep auto-loop. Optional delay arg (e.g. /nosleep-go 15m) waits between ticks like /loop; no arg continues immediately."
argument-hint: "[delay e.g. 15m | 2h | 0]"
allowed-tools: ["Bash(echo *:.claude/.nosleep-loop-active)", "Bash(printf *:.claude/.nosleep-loop-active)", "Bash(cat .claude/.nosleep-loop-active:*)", "Read(.claude/.nosleep-loop-active)"]
---

# Enable NoSleep Auto-Loop

NoSleep's auto-loop continues your work across the strategy tree without
babysitting. It has two cadences, selected by the optional argument `$ARGUMENTS`:

- **No argument (or `0`)** — *immediate continuation*. When you finish a task,
  the Stop hook injects the next strategy-tree task into THIS session right
  away. Fast, but aggressive — it never pauses.
- **A delay (e.g. `15m`, `2h`, `90m`)** — *time-based loop, like Claude-native
  `/loop`*. When you finish a task, this session ENDS cleanly and NoSleep
  schedules a one-shot wake `N` minutes out. During that dead time the
  scheduler launches a fresh session pointed at the next strategy-tree task.
  This is the calm, durable cadence — it survives the session ending and
  won't hammer your token budget.

## Steps

1. Parse `$ARGUMENTS` into whole minutes:
   - empty or `0` → `delayMinutes = 0`
   - `<n>m` → `n`
   - `<n>h` → `n * 60`
   - bare `<n>` → treat as minutes
   Clamp to the range `0`–`10080` (7 days).

2. Write the loop state file as JSON with Bash:
   `printf '{"delayMinutes": <N>}' > .claude/.nosleep-loop-active`
   (Use `0` for immediate mode.)

   Also AUTO-CONNECT this session so it's visible + steerable from the
   dashboard/mobile while the loop runs (no spawning — same as
   /nosleep-connect):
   `printf 'connected' > .claude/.nosleep-connected`

3. Report which cadence is active:
   - delay 0: "NoSleep auto-loop ENABLED (immediate). On task finish, the Stop
     hook injects the next strategy-tree task into this session. Use
     /nosleep-pause to disable."
   - delay N: "NoSleep auto-loop ENABLED (every <N>m, /loop-style). On task
     finish, this session ends and NoSleep wakes a fresh session in <N>m to
     pick up the next strategy-tree task. Use /nosleep-pause to disable."

4. Call `nosleep(action="strategy_next")` to see the next task and start it.

For longer cron-style scheduling (e.g. "review every weekday at 14:00"), use the
NoSleep dashboard's Schedules tab or the scheduled-tasks API — those run during
dead time and also process the strategy tree.
