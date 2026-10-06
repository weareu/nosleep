# Setup wizard

`npm run setup` (`node scripts/setup.mjs`) configures an installed NoSleep
checkout. It uses only Node built-ins and works on macOS, Linux and Windows.
Run `node scripts/install.mjs` first: the installer handles dependencies, the
`.env` auth keys and the embedding model. The wizard handles everything you
might choose differently.

```bash
npm run setup                          # interactive
npm run setup -- --steps llm,brain     # only some steps (llm, brain, research, claude, mobile, service, orgs, doctor)
npm run setup -- --yes                 # accept every default (= keep current values)
npm run setup -- --dry-run             # print the planned .env diff, secrets masked; write nothing
npm run doctor                         # non-interactive health check (exit 1 on a failure)
```

Each step asks "Configure …?" first, so you can skip it. Each question shows
the current value as its default, so running the wizard again only changes what
you change. `.env` edits are merges: the wizard only touches the keys it
manages. It keeps your other lines and comments, and the commented examples
from `.env.example`. `.env` is written with mode `0600`. API keys are stored
only in `.env` and show up masked (`sk-o… (51 chars)`) in all output.

`--root <dir>` (or `NOSLEEP_SETUP_ROOT`) points the wizard at another config
root, which the tests use. With a root override, steps that would change
`~/.claude`, autostart services or the live server only print what they would
run.

## 1. Memory / background AI routing

The server makes background LLM calls for four purposes. By default all of them
run on your **Claude subscription** and count against its limits. For each
purpose the wizard offers three routes:

| Route | Cost | Quality | Needs |
|---|---|---|---|
| Claude subscription (default) | Uses your plan's session limits | Best | Nothing |
| Local OpenAI-compatible (Ollama, LM Studio, llama.cpp, vLLM) | Free, uses your RAM/GPU | 7–8B models are fine for brain work, weak as a judge | A running local server and a pulled model |
| OpenRouter or another hosted API | Pay per token | Depends on the model | Base URL, API key, model id |

The wizard probes `GET /v1/models` on Ollama (`:11434`) and LM Studio (`:1234`)
and lists the installed models. You can also type any OpenAI-compatible URL.

Recommendations (from [deployment.md](deployment.md#local--alternative-models)):

| Purpose | What it does | Recommendation |
|---|---|---|
| `brain` | Auto-thought triage, metadata, thought links. Highest volume | Local 7–8B instruct (`qwen2.5:7b-instruct`, `llama3.1:8b`, `qwen3:8b`) saves the most. Models of 1–3B drop JSON fields |
| `validator` | Decides if a session met its acceptance criteria | Keep Claude unless you have a 30B+ or strong hosted model |
| `responder` | Auto-answers agent questions within 15s | Claude. A local model must be warm; if a test is slow the wizard sets `NOSLEEP_LLM_TIMEOUT_MS_RESPONDER=45000` |
| `vision` | OCR and captions | A VL model (`qwen2.5vl:7b`, `llava:7b`), Claude, or **off** |

**The test.** After you pick a model, the wizard sends one tiny chat completion,
shaped like the server's (`temperature: 0`). It prints the latency and whether
JSON came back. The first call to a local model includes the cold load, around
10–40s for a 7B model. If the call fails or returns prose, the wizard explains
why and offers to keep Claude (default yes). You can also choose a Claude
fallback (`NOSLEEP_LLM_FALLBACK_<PURPOSE>=claude`), which spends the
subscription again when the endpoint fails.

The wizard writes only per-purpose keys, as the server reads them:
`NOSLEEP_LLM_PROVIDER_<P>`, `_BASE_URL_<P>`, `_MODEL_<P>`, `_API_KEY_<P>`,
`_FALLBACK_<P>`, `_TIMEOUT_MS_<P>` (where `<P>` is `BRAIN`, `VALIDATOR`,
`RESPONDER` or `VISION`). It then runs the server's own `describeLlmRouting`
on the result and prints the line the server will log, or the error that would
stop it from starting. Restart the server to apply the changes.

## 2. Brain

| Setting | Key | Values |
|---|---|---|
| Auto-thought triage | `NOSLEEP_BRAIN_DISABLE_TRIAGE` | unset = on, `1` = off. Off means no automatic memories; manual capture still works |
| Nightly consolidator | `NOSLEEP_BRAIN_CONSOLIDATE` | `on` (default) archives stale, never-recalled thoughts; `dry-run` only logs what it would archive; `off` |

Triage runs on the `brain` route from step 1.

## 3. Research (NotebookLM)

This is optional. When it is on, sessions get `research_*` MCP tools that are
answered by Google NotebookLM, which saves Claude tokens on documentation
lookups. Trade-offs: it needs **Python 3.11+**, a **Google account**, and a
**desktop browser once** to sign in. It works through browser cookies, not an
official API, so the login can expire.

When you turn it on, the wizard:

1. finds Python 3.11 or newer and creates `packages/mcp-research/.venv`,
2. runs `pip install -e packages/mcp-research` and `python -m playwright install chromium` (about 300 MB),
3. optionally runs `python -m nosleep_research.auth`. This opens Chromium; sign
   in, and cookies are saved to `~/.notebooklm/storage_state.json` (override
   with `NOTEBOOKLM_AUTH_JSON`),
4. prints the MCP registration. The NoSleep server does **not** launch this
   server; it is a separate stdio MCP:

```bash
claude mcp add --scope user research -e NOSLEEP_ORG_ID=org_personal \
  -e NOSLEEP_DB_PATH=<repo>/data/nosleep.db -- <repo>/packages/mcp-research/.venv/bin/nosleep-research
```

Pointing `NOSLEEP_DB_PATH` at the server database makes the dashboard's research
savings visible.

**Headless Linux** (no `DISPLAY` or `WAYLAND_DISPLAY`) can't show the login
browser. Sign in on a desktop machine and copy `~/.notebooklm/storage_state.json`
across, or set `NOTEBOOKLM_AUTH_JSON`.

Turning the step off leaves an existing `.venv` in place.

## 4. Claude Code / OpenCode integration

- Registers the MCP server for every project, unless `claude mcp get nosleep`
  already finds it:
  `claude mcp add --scope user --transport http nosleep http://localhost:3777/api/mcp`.
- Copies the `/nosleep-init` and `auto-capture` skills and the `/nosleep-*`
  commands into `~/.claude`. It only copies files that are missing or differ.
- If `opencode` is on your PATH: per-project setup is the dashboard's *Install
  hooks* (targets `claude` + `opencode`). The wizard can also install the
  optional global plugin to `~/.config/opencode/plugins/nosleep.js` (see
  [opencode.md](opencode.md)).

## 5. Mobile

The wizard writes `packages/mobile/.env.local`, which is gitignored and read by
`app.config.js`. The settings are the bundle id, Apple team id, EAS project id,
Expo owner, and `EXPO_PUBLIC_NOSLEEP_URL`. For the URL it suggests your
**Tailscale** address (100.64.0.0/10), which works away from home, and your LAN
IPv4 addresses. You can also leave it blank and rely on LAN discovery.

| Path | Command (in `packages/mobile`) | Host OS | Needs |
|---|---|---|---|
| Expo Go | `npx expo start` | any | Expo Go app. No voice; push is unreliable |
| iOS release | `npx expo prebuild --clean && npx expo run:ios --configuration Release --device` | **macOS only** | Xcode, Apple team id |
| Android release | `npx expo run:android --variant release` | macOS / Linux / Windows | Android Studio + SDK (`ANDROID_HOME`), **JDK 17** |
| EAS cloud | `npx eas init`, then `npx eas build --profile preview --platform ios\|android` | any | Expo account, EAS project id |

The wizard reports what it finds: Xcode, an Android SDK, and the JDK version.
`EXPO_PUBLIC_NOSLEEP_URL` is inlined at bundle time, so restart Metro with
`npx expo start -c` or rebuild after changing it. Details: [mobile.md](mobile.md).

## 6. Autostart

This runs the same installer as `node scripts/install.mjs --service`:
LaunchAgents on macOS, systemd user units on Linux, and Task Scheduler on
Windows (experimental). The default is **No**.

## 7. Organizations

Orgs are user-defined. A fresh install has only **Personal** (`org_personal`).
This step lists the orgs the running server knows (`GET /api/orgs`) and offers
to create more: a name (1–60 chars), an optional slug (`a-z`, `0-9`, `-`, max
40; derived from the name when blank — the org id becomes `org_<slug>`) and an
optional `#rrggbb` colour (automatic when blank). Each org isolates its
projects, sessions, memory, alerts and Brain. The server must be running; if it
isn't, start it and re-run `npm run setup -- --steps orgs`. `--yes` creates
nothing. You can also manage orgs in the dashboard (Settings → Organizations),
with `POST/PATCH/DELETE /api/orgs`, or the `org_create` MCP action. For a
per-org API key set `NOSLEEP_API_KEY_<SLUG>` (upper-cased, `-` → `_`).

## 8. Doctor

`npm run doctor` (`node scripts/setup.mjs doctor`, or `node scripts/doctor.mjs`)
runs without prompts and never starts anything:

| Check | Fails when |
|---|---|
| Node version | below 22 |
| `claude` CLI | not on PATH |
| `.env` | missing, or `NOSLEEP_API_KEY` / `NOSLEEP_HOOK_SECRET` blank (warns if group/world-readable) |
| embedding model | warn only: `data/models/` incomplete, so semantic search is off |
| better-sqlite3 | the native module doesn't load under this Node (`npm rebuild better-sqlite3`) |
| server `/health` | warn only: not running |
| LLM routing | the server's own validator rejects the config (the server would refuse to start) |
| LLM endpoint | a routed endpoint doesn't answer (live test; `--no-llm-test` skips it) |
| NotebookLM | `.venv` exists but its packages don't import (warns if not logged in) |

At the end of the wizard you can start the server. The default is No.
