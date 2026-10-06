import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { REPO, mergeEnv, parseEnv } from "../install.mjs";
import { detectLocalEndpoints, envDiff, maskSecret, runDoctor, testChatCompletion } from "../doctor.mjs";
import { createPrompter, currentLlmChoice, llmUpdates, networkCandidates, runSetup } from "../setup.mjs";

// ── fake OpenAI-compatible server (node:http) ─────────────────────
let server;
let base;
let reply = '{"ok": true, "sum": 5}';
let status = 200;
const requests = [];
let orgs = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, apiKey: req.headers["x-api-key"], body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") return res.end('{"status":"ok"}');
      if (req.url === "/api/orgs" && req.method === "GET") {
        return res.end(JSON.stringify({ success: true, data: orgs }));
      }
      if (req.url === "/api/orgs" && req.method === "POST") {
        const b = JSON.parse(body);
        const slug = b.slug ?? b.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        if (orgs.some((o) => o.slug === slug)) { res.statusCode = 409; return res.end(JSON.stringify({ success: false, error: `slug "${slug}" exists` })); }
        const org = { id: `org_${slug}`, name: b.name, slug, color: b.color ?? "#ec4899", apiKeyEnv: `NOSLEEP_API_KEY_${slug.toUpperCase().replace(/-/g, "_")}` };
        orgs.push(org);
        res.statusCode = 201;
        return res.end(JSON.stringify({ success: true, data: org }));
      }
      if (status !== 200) { res.statusCode = status; return res.end("{}"); }
      if (req.method === "GET" && req.url === "/v1/models") {
        return res.end(JSON.stringify({ data: [{ id: "tiny:1b" }, { id: "qwen2.5:7b-instruct" }, { id: "qwen2.5vl:7b" }] }));
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        return res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  // Node's default 5s keep-alive lets the server close a pooled socket just as
  // undici reuses it under a loaded parallel run ("fetch failed"). Keep idle
  // sockets alive for the life of the suite.
  server.keepAliveTimeout = 120_000;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/v1`;
  const tmp = createServer();
  await new Promise((r) => tmp.listen(0, "127.0.0.1", r));
  deadUrl = `http://127.0.0.1:${tmp.address().port}/v1`;
  await new Promise((r) => tmp.close(r));
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => {
  reply = '{"ok": true, "sum": 5}'; status = 200; requests.length = 0;
  orgs = [{ id: "org_personal", name: "Personal", slug: "personal", color: "#6366f1" }];
});

let deadUrl; // a port that was just freed: connection refused

function tempRoot({ env } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nosleep-setup-"));
  copyFileSync(join(REPO, ".env.example"), join(root, ".env.example"));
  if (env !== undefined) writeFileSync(join(root, ".env"), env, { mode: 0o600 });
  return root;
}

/** Drive the real readline prompter with scripted lines. */
function scripted(lines) {
  const input = new PassThrough();
  input.end(lines.map((l) => `${l}\n`).join(""));
  return createPrompter({ input, output: new Writable({ write(_c, _e, cb) { cb(); } }) });
}

function collect() {
  const lines = [];
  return { out: (s) => lines.push(s), text: () => lines.join("\n") };
}

const snapshot = (dir) => readdirSync(dir, { recursive: true }).sort();

// ── mergeEnv / parseEnv ───────────────────────────────────────────
describe("mergeEnv", () => {
  const body = "# header\nPORT=3777\n# NOSLEEP_LLM_MODEL=example\nNOSLEEP_API_KEY=abc\n\n";

  it("replaces a key in place and leaves every other line byte-identical", () => {
    expect(mergeEnv(body, { PORT: "4000" })).toBe("# header\nPORT=4000\n# NOSLEEP_LLM_MODEL=example\nNOSLEEP_API_KEY=abc\n\n");
  });
  it("appends new keys at the end and never edits commented examples", () => {
    const out = mergeEnv(body, { NOSLEEP_LLM_MODEL: "qwen" });
    expect(out).toBe("# header\nPORT=3777\n# NOSLEEP_LLM_MODEL=example\nNOSLEEP_API_KEY=abc\nNOSLEEP_LLM_MODEL=qwen\n");
    expect(parseEnv(out).NOSLEEP_LLM_MODEL).toBe("qwen");
  });
  it("null removes the active line only", () => {
    expect(mergeEnv("A=1\n# A=2\nB=3\n", { A: null })).toBe("# A=2\nB=3\n");
  });
  it("collapses duplicates so the result is unambiguous, keeps export prefix", () => {
    expect(mergeEnv("export A=1\nB=2\nA=3\n", { A: "9" })).toBe("export A=9\nB=2\n");
  });
  it("is idempotent and a no-op for an empty update", () => {
    const once = mergeEnv(body, { X: "1" });
    expect(mergeEnv(once, { X: "1" })).toBe(once);
    expect(mergeEnv(body, {})).toBe(body);
  });
  it("quotes values that dotenv would otherwise truncate, and round-trips them", () => {
    const out = mergeEnv("", { A: "has space # not comment" });
    expect(parseEnv(out).A).toBe("has space # not comment");
  });
  it("preserves CRLF files", () => {
    expect(mergeEnv("A=1\r\nB=2\r\n", { B: "3" })).toBe("A=1\r\nB=3\r\n");
  });
  it("rejects invalid keys and multi-line values", () => {
    expect(() => mergeEnv("", { "BAD KEY": "x" })).toThrow(/invalid/);
    expect(() => mergeEnv("", { A: "x\ny" })).toThrow(/multi-line/);
  });
});

describe("parseEnv / envDiff / maskSecret", () => {
  it("follows dotenv: comments ignored, quotes and inline comments stripped, last wins", () => {
    expect(parseEnv('# A=0\nA=1 # note\nB="x # y"\nA=2\n')).toEqual({ A: "2", B: "x # y" });
  });
  it("never shows a secret in a diff", () => {
    const secret = "fake-test-value-not-a-key-0123456789";
    const lines = envDiff("A=1\n", `A=2\nNOSLEEP_LLM_API_KEY_BRAIN=${secret}\n`);
    expect(lines).toEqual(["~ A: 1 -> 2", `+ NOSLEEP_LLM_API_KEY_BRAIN=${maskSecret(secret)}`]);
    expect(lines.join("")).not.toContain(secret);
  });
});

// ── routing helpers ───────────────────────────────────────────────
describe("currentLlmChoice / llmUpdates", () => {
  it("reads per-purpose overrides over globals; vision never inherits the model", () => {
    const env = { NOSLEEP_LLM_PROVIDER: "openai", NOSLEEP_LLM_MODEL: "m", NOSLEEP_LLM_PROVIDER_VALIDATOR: "claude" };
    expect(currentLlmChoice(env, "brain")).toMatchObject({ kind: "local", model: "m" });
    expect(currentLlmChoice(env, "validator")).toEqual({ kind: "claude" });
    expect(currentLlmChoice(env, "vision")).toEqual({ kind: "off" });
    expect(currentLlmChoice({ NOSLEEP_LLM_PROVIDER: "openai", NOSLEEP_LLM_BASE_URL: "https://openrouter.ai/api/v1", NOSLEEP_LLM_MODEL: "x" }, "brain").kind).toBe("hosted");
  });
  it("Claude pins explicitly only when a global openai would otherwise win", () => {
    expect(llmUpdates({}, "brain", { kind: "claude" })).toEqual({ NOSLEEP_LLM_PROVIDER_BRAIN: null });
    expect(llmUpdates({ NOSLEEP_LLM_PROVIDER: "openai" }, "brain", { kind: "claude" })).toEqual({ NOSLEEP_LLM_PROVIDER_BRAIN: "claude" });
    expect(llmUpdates({}, "vision", { kind: "off" })).toEqual({ NOSLEEP_LLM_PROVIDER_VISION: "openai", NOSLEEP_LLM_MODEL_VISION: null });
  });
});

describe("networkCandidates", () => {
  it("lists Tailscale (100.64/10) first, then LAN; skips loopback, link-local, IPv6", () => {
    const c = networkCandidates({
      lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
      en0: [{ family: "IPv4", address: "192.168.1.5", internal: false }, { family: "IPv6", address: "fe80::1", internal: false }],
      utun4: [{ family: "IPv4", address: "100.101.2.3", internal: false }],
      cgnat: [{ family: "IPv4", address: "100.200.0.1", internal: false }],
      x: [{ family: 4, address: "169.254.1.1", internal: false }],
    }, 3777);
    expect(c.map((x) => [x.kind, x.url])).toEqual([
      ["tailscale", "http://100.101.2.3:3777"], ["lan", "http://192.168.1.5:3777"], ["lan", "http://100.200.0.1:3777"],
    ]);
  });
});

// ── endpoint detection + LLM test ─────────────────────────────────
describe("detectLocalEndpoints", () => {
  it("returns reachable endpoints with their model ids and drops dead ones", async () => {
    const found = await detectLocalEndpoints([{ name: "Fake", baseUrl: base }, { name: "Dead", baseUrl: deadUrl }]);
    expect(found).toEqual([{ name: "Fake", baseUrl: base, models: ["tiny:1b", "qwen2.5:7b-instruct", "qwen2.5vl:7b"] }]);
  });
});

describe("testChatCompletion", () => {
  it("reports latency and that JSON came back (fenced/think-wrapped JSON counts)", async () => {
    reply = "<think>hmm {not json}</think>```json\n{\"ok\": true}\n```";
    const r = await testChatCompletion({ baseUrl: base, model: "qwen2.5:7b-instruct", apiKey: "sk-test" });
    expect(r).toMatchObject({ ok: true, json: true });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    const sent = requests.find((q) => q.url === "/v1/chat/completions");
    expect(sent.auth).toBe("Bearer sk-test");
    expect(JSON.parse(sent.body)).toMatchObject({ model: "qwen2.5:7b-instruct", temperature: 0 });
  });
  it("flags prose replies as not-JSON", async () => {
    reply = "Sure! Here you go: ok";
    expect(await testChatCompletion({ baseUrl: base, model: "tiny:1b" })).toMatchObject({ ok: true, json: false });
  });
  it("explains auth and connection failures instead of throwing", async () => {
    status = 401;
    expect(await testChatCompletion({ baseUrl: base, model: "m" })).toMatchObject({ ok: false, error: "HTTP 401", hint: expect.stringMatching(/API key/) });
    expect(await testChatCompletion({ baseUrl: deadUrl, model: "m" })).toMatchObject({ ok: false, error: expect.stringMatching(/refused/) });
  });
});

// ── wizard: LLM step end to end (scripted stdin, temp root) ───────
describe("setup llm step", () => {
  it("routes brain to a detected local model, tests it, writes only brain keys", async () => {
    const root = tempRoot({ env: "PORT=3777\nNOSLEEP_API_KEY=k\nNOSLEEP_HOOK_SECRET=s\nCUSTOM=keep\n" });
    const o = collect();
    // configure step y; brain → 2 local; endpoint 1 (fake); model 2 (qwen 7b); no fallback;
    // validator/responder/vision → defaults (Claude)
    const answers = ["y", "2", "1", "2", "n", "", "", ""];
    await runSetup({ argv: ["--steps", "llm"], env: { ...process.env, NOSLEEP_SETUP_ROOT: root }, out: o.out,
      prompter: scripted(answers), localEndpoints: [{ name: "Fake", baseUrl: base }] });
    const env = parseEnv(readFileSync(join(root, ".env"), "utf8"));
    expect(env).toMatchObject({
      CUSTOM: "keep", NOSLEEP_LLM_PROVIDER_BRAIN: "openai", NOSLEEP_LLM_BASE_URL_BRAIN: base, NOSLEEP_LLM_MODEL_BRAIN: "qwen2.5:7b-instruct",
    });
    expect(Object.keys(env).filter((k) => /VALIDATOR|RESPONDER|VISION/.test(k))).toEqual([]);
    expect(o.text()).toMatch(/OK: \d+ ms, JSON came back: yes/);
    expect(o.text()).toMatch(/server will log: llm routing: brain=openai\(qwen2.5:7b-instruct @/);
    expect(statSync(join(root, ".env")).mode & 0o777).toBe(0o600);
    rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it("hosted route stores the API key only in .env and never prints it", async () => {
    const root = tempRoot({ env: "NOSLEEP_API_KEY=k\nNOSLEEP_HOOK_SECRET=s\n" });
    const o = collect();
    const key = "sk-or-v1-supersecretvalue123456";
    await runSetup({ argv: ["--steps", "llm", "--root", root], out: o.out,
      prompter: scripted(["y", "3", base, key, "openai/gpt-5-mini", "n", "", "", ""]), localEndpoints: [] });
    const env = parseEnv(readFileSync(join(root, ".env"), "utf8"));
    expect(env).toMatchObject({ NOSLEEP_LLM_PROVIDER_BRAIN: "openai", NOSLEEP_LLM_API_KEY_BRAIN: key, NOSLEEP_LLM_MODEL_BRAIN: "openai/gpt-5-mini" });
    expect(requests.find((q) => q.url === "/v1/chat/completions").auth).toBe(`Bearer ${key}`);
    expect(o.text()).not.toContain(key);
    expect(o.text()).toContain("NOSLEEP_LLM_API_KEY_BRAIN=sk-o… (31 chars)");
    rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it("on a failing endpoint explains and keeps Claude by default", async () => {
    const root = tempRoot({ env: "NOSLEEP_API_KEY=k\nNOSLEEP_HOOK_SECRET=s\n" });
    const o = collect();
    status = 500;
    // brain → local, "Enter a URL" is option 2 when nothing is detected... detection fails (status 500) → options: URL, Cancel
    const answers = ["y", "2", "1", `${base}`, "qwen2.5:7b-instruct", "", "", "", ""];
    await runSetup({ argv: ["--steps", "llm"], env: { ...process.env, NOSLEEP_SETUP_ROOT: root }, out: o.out,
      prompter: scripted(answers), localEndpoints: [{ name: "Fake", baseUrl: base }] });
    expect(o.text()).toMatch(/FAILED after \d+ ms: HTTP 500/);
    const env = parseEnv(readFileSync(join(root, ".env"), "utf8"));
    expect(env.NOSLEEP_LLM_PROVIDER_BRAIN).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  }, 60_000);
});

// ── doctor ────────────────────────────────────────────────────────
describe("doctor", () => {
  it("reports env, routing, live LLM test and server health for a temp root", async () => {
    const port = server.address().port;
    const root = tempRoot({ env: `PORT=${port}\nNOSLEEP_API_KEY=k\nNOSLEEP_HOOK_SECRET=s\nNOSLEEP_LLM_PROVIDER_BRAIN=openai\nNOSLEEP_LLM_BASE_URL_BRAIN=${base}\nNOSLEEP_LLM_MODEL_BRAIN=qwen2.5:7b-instruct\nNOSLEEP_BRAIN_CONSOLIDATE=dry-run\n` });
    const o = collect();
    const r = await runDoctor({ root, out: o.out });
    const byName = Object.fromEntries(r.checks.map((c) => [c.name, c]));
    expect(byName[".env keys"].status).toBe("ok");
    expect(byName.server.status).toBe("ok");
    expect(byName["llm routing"]).toMatchObject({ status: "ok", detail: expect.stringContaining("brain=openai(qwen2.5:7b-instruct") });
    expect(byName["llm brain"]).toMatchObject({ status: "ok", detail: expect.stringMatching(/answered in \d+ ms, JSON yes/) });
    expect(byName.brain.detail).toContain("consolidator dry-run");
    expect(byName["embedding model"].status).toBe("warn");
    expect(byName["NotebookLM research"].status).toBe("skip");
    rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it("fails on missing auth keys and on a config the server would reject", async () => {
    const root = tempRoot({ env: "NOSLEEP_API_KEY=\nNOSLEEP_LLM_PROVIDER=openai\n" });
    const r = await runDoctor({ root, out: () => {}, fetchImpl: async () => { throw new Error("down"); } });
    const byName = Object.fromEntries(r.checks.map((c) => [c.name, c]));
    expect(byName[".env keys"].status).toBe("fail");
    expect(byName["llm routing"]).toMatchObject({ status: "fail", detail: expect.stringMatching(/NOSLEEP_LLM_MODEL/) });
    expect(r.failed).toBeGreaterThanOrEqual(2);
    rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it("CLI `setup.mjs doctor` is non-interactive and exits non-zero on failure", () => {
    const root = tempRoot();
    const r = spawnSync(process.execPath, [join(REPO, "scripts", "setup.mjs"), "doctor", "--root", root, "--no-llm-test"], { encoding: "utf8", input: "" });
    expect(r.stdout).toMatch(/\[FAIL\] \.env — missing/);
    expect(r.status).toBe(1);
    rmSync(root, { recursive: true, force: true });
  }, 60_000);
});

// ── CLI: --dry-run and --yes ──────────────────────────────────────
describe("setup CLI", () => {
  const cli = (args, root) => spawnSync(process.execPath, [join(REPO, "scripts", "setup.mjs"), ...args, "--root", root],
    { encoding: "utf8", input: "", timeout: 60_000 });

  it("--yes --dry-run writes nothing and never prints a full secret", () => {
    const root = tempRoot();
    const before = snapshot(root);
    const r = cli(["--yes", "--dry-run", "--steps", "llm,brain,mobile"], root);
    expect(r.status).toBe(0);
    expect(snapshot(root)).toEqual(before);
    expect(r.stdout).toMatch(/Planned changes \(dry run/);
    expect(r.stdout).toMatch(/\+ NOSLEEP_API_KEY=\w{4}… \(64 chars\)/);
    expect(r.stdout).not.toMatch(/[0-9a-f]{64}/);
    rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it("--yes writes the expected keys to the root and keeps existing values", () => {
    const root = tempRoot({ env: "NOSLEEP_API_KEY=keepme\nNOSLEEP_HOOK_SECRET=\nNOSLEEP_BRAIN_DISABLE_TRIAGE=1\nOTHER=x\n" });
    const r = cli(["--yes", "--steps", "llm,brain,mobile"], root);
    expect(r.status).toBe(0);
    const env = parseEnv(readFileSync(join(root, ".env"), "utf8"));
    expect(env).toMatchObject({ NOSLEEP_API_KEY: "keepme", NOSLEEP_BRAIN_DISABLE_TRIAGE: "1", OTHER: "x" });
    expect(env.NOSLEEP_HOOK_SECRET).toMatch(/^[0-9a-f]{64}$/);
    const mobile = parseEnv(readFileSync(join(root, "packages", "mobile", ".env.local"), "utf8"));
    expect(mobile.NOSLEEP_BUNDLE_ID).toBe("dev.nosleep.app");
    // default URL = first detected Tailscale/LAN address (absent on a host with no network)
    expect("EXPO_PUBLIC_NOSLEEP_URL" in mobile).toBe(networkCandidates(undefined, 3777).length > 0);
    rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it("brain step writes triage/consolidator keys from interactive answers", async () => {
    const root = tempRoot({ env: "NOSLEEP_API_KEY=k\nNOSLEEP_HOOK_SECRET=s\n" });
    await runSetup({ argv: ["--steps", "brain", "--root", root], out: () => {}, prompter: scripted(["y", "n", "2"]) });
    const env = parseEnv(readFileSync(join(root, ".env"), "utf8"));
    expect(env).toMatchObject({ NOSLEEP_BRAIN_DISABLE_TRIAGE: "1", NOSLEEP_BRAIN_CONSOLIDATE: "dry-run" });
    expect(existsSync(join(root, "data"))).toBe(false); // never creates data/
    rmSync(root, { recursive: true, force: true });
  });
});

// ── organizations step ───────────────────────────────────────────
describe("orgs step", () => {
  const orgRoot = () => tempRoot({ env: `PORT=${server.address().port}\nNOSLEEP_API_KEY=setup-key\nNOSLEEP_HOOK_SECRET=s\n` });
  const posts = () => requests.filter((r) => r.method === "POST" && r.url === "/api/orgs");

  it("lists existing orgs and creates new ones through the server API", async () => {
    const root = orgRoot();
    const o = collect();
    // configure? y · create? y · Client X, slug blank, colour blank · create? y · empty name (rejected) · create? y · duplicate · create? n
    await runSetup({ argv: ["--steps", "orgs", "--root", root], out: o.out,
      prompter: scripted(["y", "y", "Client X", "", "", "y", "", "y", "Again", "client-x", "", "n"]) });
    expect(o.text()).toContain("Organizations: you have 1: Personal (org_personal)");
    expect(o.text()).toContain("created Client X (org_client-x, #ec4899)");
    expect(o.text()).toContain("NOSLEEP_API_KEY_CLIENT_X");
    expect(o.text()).toMatch(/name must be 1-60 characters/);
    expect(o.text()).toMatch(/not created: slug "client-x" exists/);
    expect(posts().map((r) => JSON.parse(r.body))).toEqual([{ name: "Client X" }, { name: "Again", slug: "client-x" }]);
    expect(posts().every((r) => r.apiKey === "setup-key")).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("--yes creates nothing, --dry-run only plans", async () => {
    const root = orgRoot();
    await runSetup({ argv: ["--yes", "--steps", "orgs", "--root", root], out: () => {} });
    expect(posts()).toEqual([]);
    const o = collect();
    await runSetup({ argv: ["--dry-run", "--steps", "orgs", "--root", root], out: o.out, prompter: scripted(["y", "y", "Side", "", "", "n"]) });
    expect(posts()).toEqual([]);
    expect(o.text()).toContain('would run: POST /api/orgs {"name":"Side"}');
    rmSync(root, { recursive: true, force: true });
  });

  it("explains how to continue when the server is down", async () => {
    const root = orgRoot();
    const o = collect();
    await runSetup({ argv: ["--steps", "orgs", "--root", root], out: o.out, prompter: scripted(["y"]),
      fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); } });
    expect(o.text()).toMatch(/Server not reachable \(connect ECONNREFUSED\).*--steps orgs/);
    rmSync(root, { recursive: true, force: true });
  });
});
