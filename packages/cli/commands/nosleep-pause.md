---
description: "Pause NoSleep auto-loop — session will stop at the end of current task instead of auto-continuing"
allowed-tools: ["Bash(rm .claude/.nosleep-loop-active:*)", "Bash(test -f .claude/.nosleep-loop-active:*)"]
---

# Pause NoSleep Auto-Loop

To pause the NoSleep auto-loop:

1. Check if active: `test -f .claude/.nosleep-loop-active && echo "ACTIVE" || echo "ALREADY_PAUSED"`
2. If ACTIVE: Remove the state file: `rm .claude/.nosleep-loop-active`
3. Report: "NoSleep auto-loop PAUSED. Session will stop after the current task. Use /nosleep-go to re-enable."
4. If ALREADY_PAUSED: Report: "NoSleep auto-loop is already paused."
