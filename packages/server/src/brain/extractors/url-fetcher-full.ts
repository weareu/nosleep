/**
 * URL full-mode extractor. Extends the ref extractor with a heuristic
 * Readability-lite: pulls the best article body (<article>, <main>, largest
 * <div>/<section>) and converts to plain text/markdown. No jsdom dep.
 *
 * Emits a document/web_fetch artifact via the ingest pipeline linked back
 * to the reference/link via link_resolved_to_fetch edge.
 */

import { fetchRef, normaliseUrl } from "./url-fetcher-ref.js";
import { ingest } from "../ingest/pipeline.js";
import { safeFetch, SsrfBlockedError } from "./url-fetch-guard.js";

const FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const USER_AGENT = "NoSleep-Brain/0.1 (+self-archive)";

export interface FullCaptureRequest {
  url: string;
  org_id: string;
  project_id: string;
  link_hash: string;
  tags?: string[];
}

export interface FullCaptureResult {
  fetch_hash: string | null;
  article_length: number;
  title: string | null;
  excerpt: string | null;
  error: string | null;
}

/**
 * Fetch + extract + ingest the article body. Returns the hash of the new
 * document/web_fetch artifact (or null on fetch failure).
 */
export async function captureUrlFull(
  req: FullCaptureRequest,
): Promise<FullCaptureResult> {
  const normalized = normaliseUrl(req.url);
  const meta = await fetchRef(req.url);

  if (meta.error) {
    return {
      fetch_hash: null,
      article_length: 0,
      title: meta.title,
      excerpt: null,
      error: meta.error,
    };
  }

  let html = "";
  try {
    const res = await safeFetch(normalized, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        fetch_hash: null,
        article_length: 0,
        title: meta.title,
        excerpt: null,
        error: "HTTP " + res.status,
      };
    }
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.includes("html") && !ct.includes("xml")) {
      return {
        fetch_hash: null,
        article_length: 0,
        title: meta.title,
        excerpt: null,
        error: "non-HTML content",
      };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BODY_BYTES) {
      html = buf.slice(0, MAX_BODY_BYTES).toString("utf8");
    } else {
      html = buf.toString("utf8");
    }
  } catch (err) {
    const reason =
      err instanceof SsrfBlockedError
        ? `SSRF blocked: ${err.reason}`
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      fetch_hash: null,
      article_length: 0,
      title: meta.title,
      excerpt: null,
      error: reason,
    };
  }

  const article = extractArticle(html);
  const bodyText = htmlToText(article.html);
  const markdown = bodyText.trim();

  if (markdown.length < 50) {
    return {
      fetch_hash: null,
      article_length: markdown.length,
      title: meta.title,
      excerpt: null,
      error: "extracted body too short — likely paywall or JS-rendered page",
    };
  }

  const result = ingest({
    kind: "document/web_fetch",
    content: markdown,
    content_type: "text/markdown",
    org_id: req.org_id,
    project_id: req.project_id,
    origin: { tool: "brain-api", version: "0.1", actor: "url_full" },
    edges: [
      {
        to_hash: req.link_hash,
        relation: "link_resolved_to_fetch",
      },
    ],
    kind_specific_meta: {
      final_url: normalized,
      title: meta.title,
      description: meta.description,
      author: meta.author,
      language: meta.language,
      og_site_name: meta.og_site_name,
      article_bytes: markdown.length,
      source_link_hash: req.link_hash,
      tags: req.tags ?? [],
    },
    schema_version: 1,
  });

  return {
    fetch_hash: result.hash,
    article_length: markdown.length,
    title: meta.title,
    excerpt: markdown.slice(0, 240),
    error: null,
  };
}

// ── Heuristic article extraction ─────────────────────────

interface ArticleBlock {
  html: string;
  score: number;
}

/**
 * Pick the best article container via size + structural heuristics.
 * Order of preference:
 *   1. <article>
 *   2. <main>
 *   3. the largest <div> or <section> by text-content length
 */
function extractArticle(html: string): ArticleBlock {
  const stripped = stripNoise(html);

  const articleMatch = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(stripped);
  if (articleMatch) return { html: articleMatch[1], score: 1.0 };

  const mainMatch = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(stripped);
  if (mainMatch) return { html: mainMatch[1], score: 0.8 };

  // Score divs/sections by text content length
  const container = /<(div|section)[^>]*>([\s\S]*?)<\/\1>/gi;
  let best: ArticleBlock = { html: stripped, score: 0 };
  let m: RegExpExecArray | null;
  while ((m = container.exec(stripped)) !== null) {
    const inner = m[2];
    const textLen = htmlToText(inner).length;
    if (textLen > best.score) best = { html: inner, score: textLen };
  }
  return best;
}

function stripNoise(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/p\s*>/gi, "\n\n")
    .replace(/<\s*\/div\s*>/gi, "\n")
    .replace(/<\s*\/li\s*>/gi, "\n")
    .replace(/<\s*\/h[1-6]\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
