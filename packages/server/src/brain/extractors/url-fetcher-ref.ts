/**
 * URL ref-mode fetcher. Extracts og-tags + title + description — enough to
 * create a reference/link artifact. Full-mode (Readability → markdown +
 * embedding) lands in Phase 3.
 *
 * Uses regex extraction rather than a DOM library to keep Phase 1 deps lean.
 */

import { safeFetch, SsrfBlockedError } from "./url-fetch-guard.js";

const USER_AGENT = "NoSleep-Brain/0.1 (+self-archive)";
const FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface UrlRefMetadata {
  url: string;
  normalized_url: string;
  status: number;
  content_type: string | null;
  title: string | null;
  description: string | null;
  og_image: string | null;
  og_site_name: string | null;
  author: string | null;
  domain: string;
  language: string | null;
  fetched_at: number;
  body_hash: string | null;
  fetched_bytes: number;
  truncated: boolean;
  error: string | null;
}

/** Normalise a URL for stable content-addressing of the ref artifact. */
export function normaliseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    u.protocol = u.protocol.toLowerCase();
    const params = [...u.searchParams.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    u.search = "";
    for (const [k, v] of params) u.searchParams.append(k, v);
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * Fetch URL and extract ref metadata. Non-throwing — returns an error field
 * if fetch fails.
 */
export async function fetchRef(rawUrl: string): Promise<UrlRefMetadata> {
  const normalized = normaliseUrl(rawUrl);
  const ts = Math.floor(Date.now() / 1000);
  const domain = hostOf(normalized);

  const base: UrlRefMetadata = {
    url: rawUrl,
    normalized_url: normalized,
    status: 0,
    content_type: null,
    title: null,
    description: null,
    og_image: null,
    og_site_name: null,
    author: null,
    domain,
    language: null,
    fetched_at: ts,
    body_hash: null,
    fetched_bytes: 0,
    truncated: false,
    error: null,
  };

  try {
    const res = await safeFetch(normalized, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.5",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    base.status = res.status;
    base.content_type = res.headers.get("content-type");

    if (!res.ok) {
      base.error = "HTTP " + res.status;
      return base;
    }

    const buf = await readBodyCapped(res);
    base.fetched_bytes = buf.length;
    base.truncated = buf.length >= MAX_BODY_BYTES;

    const ct = (base.content_type ?? "").toLowerCase();
    if (!ct.includes("html") && !ct.includes("xml")) {
      return base;
    }

    const html = buf.toString("utf8");
    const meta = extractMetaFromHtml(html);
    base.title = meta.title;
    base.description = meta.description;
    base.og_image = meta.og_image;
    base.og_site_name = meta.og_site_name;
    base.author = meta.author;
    base.language = meta.language;
    base.body_hash = simpleHash(html);
    return base;
  } catch (err) {
    base.error =
      err instanceof SsrfBlockedError
        ? `SSRF blocked: ${err.reason}`
        : err instanceof Error
          ? err.message
          : String(err);
    return base;
  }
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
}

async function readBodyCapped(res: Response): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    if (r.value) {
      chunks.push(r.value);
      total += r.value.length;
      if (total >= MAX_BODY_BYTES) {
        reader.cancel();
        break;
      }
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

interface ExtractedMeta {
  title: string | null;
  description: string | null;
  og_image: string | null;
  og_site_name: string | null;
  author: string | null;
  language: string | null;
}

function extractMetaFromHtml(html: string): ExtractedMeta {
  const m: ExtractedMeta = {
    title: null,
    description: null,
    og_image: null,
    og_site_name: null,
    author: null,
    language: null,
  };

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleMatch) m.title = decodeEntities(titleMatch[1].trim()).slice(0, 500);

  const ogTitle = metaContent(html, "og:title", true);
  if (ogTitle) m.title = ogTitle.slice(0, 500);

  m.description =
    metaContent(html, "og:description", true) ??
    metaContent(html, "description", false);
  if (m.description) m.description = m.description.slice(0, 2000);

  m.og_image = metaContent(html, "og:image", true);
  m.og_site_name = metaContent(html, "og:site_name", true);
  m.author = metaContent(html, "author", false);

  const langMatch = /<html[^>]*\slang\s*=\s*["']([^"']+)["']/i.exec(html);
  if (langMatch) m.language = langMatch[1].slice(0, 16);

  return m;
}

function metaContent(html: string, name: string, isProperty: boolean): string | null {
  const attr = isProperty ? "property" : "name";
  const re = new RegExp(
    "<meta[^>]*\\b" + attr + "\\s*=\\s*[\"']" + escapeRegex(name) + "[\"'][^>]*>",
    "i",
  );
  const m = re.exec(html);
  if (!m) return null;
  const contentMatch = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(m[0]);
  return contentMatch ? decodeEntities(contentMatch[1].trim()) : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h.toString(16).padStart(8, "0");
}
