---
description: "Show NoSleep loop status, current task, and strategy tree progress"
allowed-tools: ["Bash(test -f .claude/.nosleep-loop-active:*)", "Bash(cat .claude/.nosleep-tool-count:*)", "Bash(cat .claude/.nosleep-last-task:*)"]
---

# NoSleep Status

Show the current NoSleep loop status:

1. Check loop state: `test -f .claude/.nosleep-loop-active && echo "LOOP: ACTIVE" || echo "LOOP: PAUSED"`
2. Check tool count: `cat .claude/.nosleep-tool-count 2>/dev/null || echo "0"`
3. Check last task: `cat .claude/.nosleep-last-task 2>/dev/null || echo "none"`
4. Call `nosleep(action="strategy_next")` to show what's coming next
5. Report all of the above in a clean summary
