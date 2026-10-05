# NoSleep Troubleshooting Runbook

Symptom-first guide. Each section: how to diagnose, how to fix.

**Start with `npm run doctor`.** It checks Node, `claude`, `.env`, the embedding
model, SQLite, server health and LLM endpoints, and names the failing piece.

Commands are shown for macOS (LaunchAgents). On Linux use the systemd
equivalents in [deployment.md](deployment.md#running-as-a-service), e.g.
`systemctl --user restart nosleep-server` and `journalctl --user -u nosleep-server`.

---

## Server is down or unreachable

```bash
launchctl list | grep nosleep            # Both should show PID column 1, exit code 0
curl -s http://localhost:3777/health     # Should return JSON
tail -50 ~/.nosleep/server.err           # Last error before crash
```

**Common causes:**
- **Crashed on startup** — check `server.err`; look for `unhandledRejection`, `EADDRINUSE`, or `database is locked`
- **Port in use** — `lsof -i :3777` to find the squatter, kill it
- **Database locked** — another process holds the WAL writer (check for stray `node` processes from dev mode while LaunchAgent is also running)
- **Disk image not mounted (mobile builds)** — phone is locked; unlock and retry

**Restart:**
```bash
launchctl kickstart -k gui/$(id -u)/com.nosleep.server
```

If `server.log` is huge (>100MB), rotate it:
```bash
mv ~/.nosleep/server.log ~/.nosleep/server.log.old
launchctl kickstart -k gui/$(id -u)/com.nosleep.server
```

---

## Mobile app shows "Network request failed"

1. Verify the API key is set in **Settings** → **API Key**
2. Verify the server URL — should be `http://<ip>:3777`
3. From the phone, the IP must be reachable. On Tailscale: `100.x.x.x`. On WiFi: `192.168.x.x`.
4. iOS App Transport Security blocks plain HTTP to non-local IPs. The fix lives in `app.json`: `expo.ios.infoPlist.NSAppTransportSecurity.NSAllowsArbitraryLoads: true`. Verify with:
   ```bash
   plutil -p ios/nosleep/Build/Products/Release-iphoneos/NoSleep.app/Info.plist | grep -A2 AppTransport
   ```
5. CORS: only ports `5173`, `3777`, `19006` are allowed. If your dashboard runs elsewhere, update `ALLOWED_CORS_PORTS` in `server.ts`.

---

## "ambiguous column name: id" in MCP gateway

Restart your Claude Code session. The MCP gateway is spawned per-session; an in-flight gateway process holds the old code in memory. Closing and reopening Claude Code re-spawns it with the latest fix.

Verify the source query is clean:
```bash
grep -n "SELECT id," packages/mcp-gateway/src/actions.ts
# Should not match — all queries should alias as 'goal_id', 'session_id', etc.
```

---

## Scheduled task wedged ("currentTaskRunning forever")

Symptom: scheduler logs `Queued N tasks` once, then nothing for hours.

1. Check `~/.nosleep/server.err` — likely `Session blocked by budget pacer` from a prior run
2. The reaper (`reapDeadManagedSessions`) clears stuck sessions every 60s. If a session is `running` with a dead PID, it'll be marked `failed` next tick.
3. Force-clear if needed:
   ```sql
   sqlite3 data/nosleep.db
   UPDATE sessions SET status='failed', ended_at=datetime('now')
     WHERE status='running' AND last_activity_at < datetime('now','-1 hour');
   ```
4. Restart server.

---

## Daily budget overdrawn (sessions all rejected)

```bash
curl -s -H "x-api-key: $NOSLEEP_API_KEY" "http://localhost:3777/api/analytics/pacing"
```

Returns current pacing mode + reason.

**If wrongly stuck:**
```sql
-- Check today's usage:
SELECT account_id, SUM(input_tokens + output_tokens) AS used
FROM token_usage WHERE recorded_at >= date('now') GROUP BY account_id;

-- Check the limit:
SELECT id, daily_token_limit FROM accounts;
```

If usage truly exceeds limit, **wait until tomorrow** or raise the account limit (`PATCH /api/accounts/:id` is not yet implemented — direct SQL works).

---

## Server keeps OOM-killing on startup

Vector indexer re-indexes all active projects on boot. With many projects, this can spike memory.

**Mitigation (immediate):**
```bash
# Skip vector init by setting an env var (not yet wired — TODO)
# OR: deactivate projects you don't need indexed
sqlite3 data/nosleep.db "UPDATE projects SET active = 0 WHERE id = 'xxx';"
```

**Long-term fix:** move embedder to a `worker_thread` (architecture review item #2 — pending).

---

## Session crashed without exit handler firing

The reaper catches this within 60s (every scheduler tick). Look for log line:
```
[task-scheduler] Reaped N stale managed session(s) with dead PIDs
```

And check the `alerts` table for `type='stale_session_reaped'`.

If the reaper is missing the session (e.g., PID actually still alive but Claude is hung):
```bash
ps -p <pid> -o pid,etime,command   # confirm process
kill -TERM <pid>                   # graceful
kill -KILL <pid>                   # nuclear
```

---

## "Cannot launch NoSleep on iPhone because the device is locked"

Unlock the phone, then re-run the install:
```bash
xcrun devicectl device install app --device <UDID> \
  ~/Library/Developer/Xcode/DerivedData/NoSleep-*/Build/Products/Release-iphoneos/NoSleep.app
```

The developer disk image only mounts when the device is unlocked.

---

## WebSocket clients keep disconnecting

Check the heartbeat:
```bash
grep -i "heartbeat\|terminate" ~/.nosleep/server.log | tail -20
```

If many `terminate` events, the event loop is stalling (>30s). Common cause: vector reindex on a huge project. Workaround:
```bash
# Disable vector indexing for the offending project temporarily
sqlite3 data/nosleep.db "UPDATE projects SET active = 0 WHERE id = 'xxx';"
launchctl kickstart -k gui/$(id -u)/com.nosleep.server
```

---

## Goal injection isn't reaching Claude

PreToolUse hook drains the message queue. If hook callbacks are failing:
```bash
grep "/api/hooks/pre-tool" ~/.nosleep/server.log | tail -20
# Look for 4xx/5xx
```

Common causes:
- Hook script not installed: `claude --print "" --` should write to your project's `.claude/settings.json`. Check it.
- Server unreachable from the hook subprocess (e.g., wrong port in installed hook)
- Body limit exceeded (1MB) — large tool result truncated; the queue still drains

Re-install hooks:
```bash
curl -s -X POST -H "x-api-key: $NOSLEEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"scope":"project","target":"/path/to/project"}' \
  http://localhost:3777/api/hooks/install
```

---

## Strategy tree won't auto-advance

After a session completes successfully:
1. Check `verdict='complete'` in `validations` table
2. Check the strategy node has `assigned_session_id = <session>`
3. Rate limit: max 10 auto-advances per hour (per project). Look for log:
   ```
   [supervision] auto-advance rate-limited
   ```
4. Dependency block: the next leaf has unsatisfied `dependsOn`. Inspect:
   ```bash
   curl -s -H "x-api-key: $NOSLEEP_API_KEY" \
     http://localhost:3777/api/strategy/tree/<projectId>/next
   ```

---

## Drift alerts firing on every output

The embedding-based detector threshold is `0.35` (cosine similarity). If your goals are short or generic, false positives are likely.

Tune in `embedding-drift-detector.ts`:
- Higher threshold (e.g., `0.5`) → fewer alerts, more false negatives
- Lower threshold (e.g., `0.2`) → more alerts

Or: rewrite the goal to be more specific (drift detector embeds the goal text — vague goals embed close to everything).

---

## Tailscale not working from mobile

Background: homebrew Tailscale runs in **userspace mode** (SOCKS5 only, no `utun`). Server `0.0.0.0` binding still doesn't get hit because there's no real network interface.

**Fix:** install Tailscale Mac App from the App Store. Then:
```bash
brew uninstall tailscale 2>/dev/null
rm -rf ~/.tailscale
ifconfig | grep "inet 100\."   # Must show your Tailscale IP
```

Set `EXPO_PUBLIC_NOSLEEP_URL` in `packages/mobile/.env.local` (then rebuild), or enter the address in the app's Settings.

---

## Need to nuke and start over

```bash
# Stop everything
launchctl unload ~/Library/LaunchAgents/com.nosleep.server.plist
launchctl unload ~/Library/LaunchAgents/com.nosleep.web.plist

# Wipe DB
rm data/nosleep.db data/nosleep.db-wal data/nosleep.db-shm

# Rebuild deps
rm -rf node_modules
npm install

# Restart
launchctl load ~/Library/LaunchAgents/com.nosleep.server.plist
launchctl load ~/Library/LaunchAgents/com.nosleep.web.plist
```

Schema migrations recreate everything from scratch on first start.

---

## Useful one-liners

```bash
# Most recent session per project
sqlite3 data/nosleep.db "SELECT project_id, MAX(started_at), status FROM sessions GROUP BY project_id;"

# Top token spenders today
sqlite3 data/nosleep.db "SELECT project_id, SUM(input_tokens+output_tokens) AS used FROM token_usage WHERE recorded_at >= date('now') GROUP BY project_id ORDER BY used DESC LIMIT 10;"

# Stuck sessions
sqlite3 data/nosleep.db "SELECT id, status, last_activity_at FROM sessions WHERE status='running' AND last_activity_at < datetime('now','-1 hour');"

# Tail live activity
tail -f ~/.nosleep/server.log | grep -E "supervision|task-scheduler|crash"
```
