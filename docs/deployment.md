# Deployment Guide

NoSleep is a single-machine workstation orchestrator. macOS is the daily
driver; Linux is supported for the server + dashboard; Windows is beta
(WSL2 recommended).

## Prerequisites

- Node.js 22+ (`.nvmrc` pins the tested version)
- Claude Code CLI on PATH and logged in (`claude`)
- A C/C++ toolchain only if `better-sqlite3`/`onnxruntime-node` have no
  prebuilt binary for your platform
- Optional: Tailscale for phone access away from your LAN (on macOS use the
  App Store app — see below)

## Install

```bash
git clone https://github.com/weareu/nosleep.git && cd nosleep
node scripts/install.mjs             # npm install, .env with fresh keys, embedding model
```

| Flag | Effect |
|------|--------|
| `--service` | Install autostart (see below) |
| `--uninstall-service` | Remove autostart |
| `--dry-run` | Print what would be written; change nothing |
| `--skip-deps` | Skip `npm install` |
| `--skip-models` | Skip the ~23 MB embedding model download |

Re-running is safe: existing `.env` values and `data/` are never touched.

`.env` keys:
- `NOSLEEP_API_KEY` — required `x-api-key` for non-loopback clients (generated)
- `NOSLEEP_HOOK_SECRET` — hook callback authentication (generated)
- `PORT` — defaults to 3777
- `DB_PATH` — defaults to `./data/nosleep.db`

## Running in dev

```bash
npm run dev:server   # tsx watch on :3777
npm run dev:web      # Vite HMR on :5173
```

## Running as a service

`node scripts/install.mjs --service` writes and loads:

| OS | Units | Restart after code change | Status | Logs |
|----|-------|---------------------------|--------|------|
| macOS | `~/Library/LaunchAgents/com.nosleep.{server,web,watchdog}.plist` | `launchctl kickstart -k gui/$(id -u)/com.nosleep.server` | `launchctl list \| grep nosleep` | `~/.nosleep/server.{log,err}` |
| Linux | `~/.config/systemd/user/nosleep-{server,web}.service` | `systemctl --user restart nosleep-server` | `systemctl --user status nosleep-server` | `journalctl --user -u nosleep-server -f` |
| Windows | Task Scheduler `NoSleepServer`, `NoSleepWeb` (at logon) | `schtasks /End /TN NoSleepServer` then `/Run` | `schtasks /Query /TN NoSleepServer` | `%USERPROFILE%\.nosleep\server.log` |

The service runs the server from source with `tsx` (no build step), so a
restart picks up code changes. The node binary and the directory of `claude`
are baked into the unit's PATH at install time — re-run `--service` after
changing Node versions.

On Linux, `loginctl enable-linger $USER` keeps the services running while
you're logged out.

## Watchdog (macOS)

`com.nosleep.watchdog` runs `scripts/watchdog.sh` every 30s. It probes
`/health` and, after 4 consecutive failures (~2 min — longer than a slow
startup), kicks the server with `launchctl kickstart -k`. Log:
`~/Library/Logs/nosleep-watchdog.log`. On Linux, systemd's
`Restart=on-failure` covers crashes (not a wedged event loop).

## Menu bar app (macOS)

```bash
tools/menubar/scripts/install.sh
```

Builds the Swift app into `~/Applications/NoSleepStatus.app`, ad-hoc signs it
and adds `com.nosleep.menubar`. Needs Xcode command line tools.

## Mobile app

See [mobile.md](mobile.md).

## Tailscale

For phone access away from your LAN, the host must be reachable on its
Tailscale `100.x.y.z` address. On macOS the Homebrew Tailscale CLI runs in
**userspace** mode (SOCKS5 only, no real interface), so inbound connections
fail — install the **Tailscale app from the App Store** instead.

```bash
ifconfig | grep "inet 100\."   # should show your Tailscale IP
```

Then set `EXPO_PUBLIC_NOSLEEP_URL=http://<tailscale-ip>:3777` in
`packages/mobile/.env.local`, or type the address in the app's Settings.

## Database

SQLite at `data/nosleep.db` with WAL mode. Schema migrations are idempotent and run on every server start (see `packages/server/src/db/schema.ts`).

To inspect:
```bash
sqlite3 data/nosleep.db
.tables
.schema sessions
SELECT COUNT(*) FROM sessions;
```

To reset everything (DESTRUCTIVE):
```bash
rm data/nosleep.db data/nosleep.db-wal data/nosleep.db-shm
# then restart the server (see table above) — the schema is recreated on boot
```

## Vector search

Vector index is in `packages/server/src/embeddings/`. Embeddings use ONNX MiniLM-L6-v2 (~22MB).

Model files at `data/models/`:
- `minilm-l6-v2.onnx`
- `tokenizer.json`

If missing, re-run `node scripts/install.mjs` (it downloads the quantized `Xenova/all-MiniLM-L6-v2` files). Vector search is non-fatal — server runs without it (semantic search returns no results).

## Local / alternative models

The server makes background LLM calls that, by default, run on your Claude
subscription (via the Agent SDK / `claude` CLI) and count against its session
limits. Each workload ("purpose") can instead be sent to any **OpenAI-compatible
Chat Completions** endpoint: Ollama, LM Studio, llama.cpp `llama-server`, vLLM,
OpenRouter or OpenAI.

| Purpose | Callers | Notes |
|---------|---------|-------|
| `brain` | auto-thought triage, metadata extraction, thought-ref proposer | Highest volume. Rate-limited by the brain budget breaker (`NOSLEEP_BRAIN_SOFT_LIMIT` / `_HARD_LIMIT`) whichever provider serves it. The best candidate for local. |
| `validator` | AI completeness validator (session exit) | Low volume, judgement-heavy. Keep on Claude unless you have a strong model. |
| `responder` | Auto-answers to agent questions (continue / next task / escalate) | 15s caller timeout; a cold local model can miss it (see `NOSLEEP_LLM_TIMEOUT_MS_RESPONDER`). Timeouts fall back to "continue". |
| `vision` | Image OCR + caption + scene class | Routes to openai **only** with `NOSLEEP_LLM_MODEL_VISION` set; it never inherits the text model. |

### Environment

Every key also accepts a per-purpose override by appending `_BRAIN`,
`_VALIDATOR`, `_RESPONDER` or `_VISION`. The override wins over the global key.

| Variable | Default | Meaning |
|----------|---------|---------|
| `NOSLEEP_LLM_PROVIDER` | `claude` | `claude` keeps today's behaviour exactly. `openai` sends to the endpoint below. |
| `NOSLEEP_LLM_BASE_URL` | `http://localhost:11434/v1` | The OpenAI-compatible base URL. The server POSTs to `<base>/chat/completions`. |
| `NOSLEEP_LLM_MODEL` | none | Required when the provider is `openai` (except vision, see below). |
| `NOSLEEP_LLM_API_KEY` | none | Sent as `Authorization: Bearer …` only when set. Not needed for local servers. It never appears in logs. |
| `NOSLEEP_LLM_TIMEOUT_MS` | the caller's timeout | Overrides the hard timeout for the openai route (brain is 60s, validator 60s, responder 15s). |
| `NOSLEEP_LLM_FALLBACK` | `none` | `claude` retries a failed openai call on Claude, which spends the subscription again. With `none`, failures go to each caller's existing skip/null handling. Vision never falls back. |
| `NOSLEEP_LLM_MODEL_VISION` | none | The vision-capable model (for example `qwen2.5vl:7b` or `llava:7b`). Without it, a vision purpose resolving to `openai` is **off**, which means images get no OCR or caption. Set `NOSLEEP_LLM_PROVIDER_VISION=claude` to keep Claude vision. |

At startup the server validates this config and logs one line, for example:

```
llm routing: brain=openai(qwen2.5:7b-instruct-q4_K_M @ http://localhost:11434/v1) validator=claude responder=claude vision=off (provider openai but NOSLEEP_LLM_MODEL_VISION unset)
```

An invalid config (unknown provider, bad URL, openai without a model) fails
startup with a message that names the variable.

**Robustness.** A local server that is down fails immediately with connection
refused and never hangs. Every call has a hard timeout. Each endpoint has its
own circuit breaker: after 5 consecutive failures it fails fast for 10 minutes,
and that does not affect the Claude breaker. `<think>…</think>` reasoning blocks
(qwen3, deepseek-r1 and similar) are stripped before the callers parse JSON.
The callers already accept JSON wrapped in fenced code blocks marked `json`.
Requests use `temperature: 0`.

### Examples

Move only the memory/brain work to a local Ollama model, and keep the validator
and responder on Claude:

```bash
ollama pull qwen2.5:7b-instruct
# .env
NOSLEEP_LLM_PROVIDER_BRAIN=openai
NOSLEEP_LLM_MODEL_BRAIN=qwen2.5:7b-instruct
# NOSLEEP_LLM_BASE_URL_BRAIN defaults to http://localhost:11434/v1
```

LM Studio uses `NOSLEEP_LLM_BASE_URL_BRAIN=http://localhost:1234/v1`.
llama.cpp uses `llama-server -m model.gguf --port 8080` with
`NOSLEEP_LLM_BASE_URL_BRAIN=http://localhost:8080/v1`.

Send everything except vision to OpenRouter:

```bash
NOSLEEP_LLM_PROVIDER=openai
NOSLEEP_LLM_BASE_URL=https://openrouter.ai/api/v1
NOSLEEP_LLM_MODEL=openai/gpt-5-mini
NOSLEEP_LLM_API_KEY=sk-or-...
NOSLEEP_LLM_PROVIDER_VISION=claude   # or set NOSLEEP_LLM_MODEL_VISION
```

Restart the server after changing `.env`.

### Quality caveats

- The brain prompts ask for strict JSON. Models of 7–8B or larger (qwen2.5 7B
  instruct, llama3.1 8B, qwen3 8B) handle this reliably. 1–3B models often drop
  fields, add prose, or misclassify keep/skip. The callers then skip the item
  (null). Nothing gets corrupted, but recall drops. Look for
  `[auto-thought] unparseable verdict` in the server log.
- Triage judgement (what is worth remembering) and relation labelling are
  weaker on small models than on Haiku. Expect more noise in auto-thoughts and
  more `null` relations from the proposer.
- The validator decides whether a session's acceptance criteria are met, and a
  weak model gives confident wrong verdicts. Keep it on Claude unless you use a
  model of 30B or larger, or a capable hosted model.
- On first use a local model has a cold-load delay (around 10s for a 7B model on
  Apple Silicon). Raise `NOSLEEP_LLM_TIMEOUT_MS_<PURPOSE>` if calls time out,
  especially for the responder.

## Network

| Port | Service | Bound to |
|------|---------|----------|
| 3777 | API server | `0.0.0.0` |
| 5173 | Web dashboard | `0.0.0.0` |
| 41234 | UDP discovery beacon | broadcast |

## Backup

Just copy `data/nosleep.db` (with the WAL/SHM files). better-sqlite3 supports SQLite's online backup API but no script ships yet — `cp` while server is running works because of WAL mode.

```bash
cp data/nosleep.db backups/nosleep-$(date +%F).db
```
