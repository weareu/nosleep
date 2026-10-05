import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Brain uploads (photos, voice) used to fail invisibly: brainApi threw to a
// transient toast and nothing reached the server log. Failures must be
// reported to /api/client-log via clientLog.report.
const report = vi.fn();
vi.mock("../services/clientLog", () => ({ report: (...args: unknown[]) => report(...args) }));
vi.mock("../config", () => ({
  getServerConfig: async () => ({ apiUrl: "http://10.0.0.5:3777", wsUrl: "", apiKey: "k" }),
}));

import { ingestImage } from "../services/brainApi";

const photo = { base64: "aGVsbG8=", content_type: "image/jpeg", org_id: "org_personal", project_id: "_org_level" };

describe("brainApi upload failures are reported", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => report.mockReset());
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("posts the photo to /api/brain/ingest as a media/image/photo artifact", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ hash: "h", duplicate: false, enqueued: [], size: 5, latency_ms: 1 }), { status: 202 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = await ingestImage(photo);
    expect(res.hash).toBe("h");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://10.0.0.5:3777/api/brain/ingest");
    expect(JSON.parse(String(init.body))).toMatchObject({ kind: "media/image/photo", content_type: "image/jpeg", content: "aGVsbG8=" });
    expect(report).not.toHaveBeenCalled();
  });

  it("an HTTP error is thrown AND reported with status and path", async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"error":{"code":"SIZE_LIMIT"}}', { status: 413 })) as unknown as typeof fetch;
    await expect(ingestImage(photo)).rejects.toThrow(/413/);
    expect(report).toHaveBeenCalledWith(
      "warn",
      "brainApi.http",
      "413 POST /api/brain/ingest",
      expect.objectContaining({ status: 413, path: "/api/brain/ingest" }),
    );
  });

  it("a network failure is thrown AND reported", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Network request failed");
    }) as unknown as typeof fetch;
    await expect(ingestImage(photo)).rejects.toThrow("Network request failed");
    expect(report).toHaveBeenCalledWith(
      "error",
      "brainApi.fetch",
      "Network request failed",
      expect.objectContaining({ path: "/api/brain/ingest", hasKey: true }),
      expect.any(String),
    );
  });
});
