import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { humanizeApiError } from "../../lib/humanize-error";
import { brainGetArtifact, type BrainArtifact as BrainArtifactT } from "../../lib/brainApi";
import {
  BrainDetailHero,
  BrainDetailToolbar,
  CodeIcon,
  CopyIcon,
  GraphIcon,
  SessionIcon,
} from "../../components/BrainDetailHero";
import { JsonViewerModal } from "../../components/JsonViewerModal";
import { JsonTree } from "../../components/JsonTree";
import { Markdown } from "../../components/Markdown";

export function BrainArtifact(): React.ReactElement {
  const { hash = "" } = useParams();
  const [params] = useSearchParams();
  // Prefer ?org= (matches the BrainLayout picker URL convention) and
  // fall back to ?org_id= so older bookmarks / external links keep
  // working. New link generators should emit ?org=.
  const orgId =
    params.get("org") ?? params.get("org_id") ?? "org_personal";

  const [a, setA] = useState<BrainArtifactT | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);

  useEffect(() => {
    if (!hash) return;
    setLoading(true);
    brainGetArtifact(hash, orgId, ["edges", "ingest_event"])
      .then(setA)
      .catch((e) => setErr(humanizeApiError(e)))
      .finally(() => setLoading(false));
  }, [hash, orgId]);

  const heroTitle = a ? deriveArtifactTitle(a) : "Artifact";
  const heroSubtitle = a ? (
    <>
      <span className="font-mono">{a.kind}</span>
      <span>·</span>
      <span>{new Date(a.ts * 1000).toLocaleString()}</span>
      <span>·</span>
      <span>{a.size.toLocaleString()} bytes</span>
      {a.origin.tool && (
        <>
          <span>·</span>
          <span>
            from <span className="font-mono">{a.origin.tool}</span>
          </span>
        </>
      )}
    </>
  ) : null;

  return (
    <div className="p-6 space-y-4 text-slate-200">
      <BrainDetailToolbar
        actions={[
          {
            label: "Copy hash",
            icon: <CopyIcon />,
            onClick: () => navigator.clipboard.writeText(hash).catch(() => {}),
          },
          {
            label: "Open graph",
            icon: <GraphIcon />,
            to: `/brain/graph?org_id=${orgId}&focus=${hash}`,
          },
          {
            label: "Open session",
            icon: <SessionIcon />,
            to: a?.session_id
              ? `/brain/session/${a.session_id}?org_id=${orgId}`
              : undefined,
            disabled: !a?.session_id,
          },
          {
            label: "Raw JSON",
            icon: <CodeIcon />,
            onClick: () => setShowJson(true),
            disabled: !a,
          },
        ]}
      />

      <JsonViewerModal
        open={showJson}
        onClose={() => setShowJson(false)}
        title={`Artifact ${hash.slice(0, 12)}…`}
        data={a}
      />


      <BrainDetailHero
        eyebrow="Artifact"
        title={heroTitle}
        subtitle={heroSubtitle}
        identifier={hash}
      />

      {err && (
        <div role="alert" className="text-red-400 bg-red-950/30 border border-red-900 p-3 rounded">
          {err}
        </div>
      )}

      {loading ? (
        <div className="text-slate-400">loading…</div>
      ) : a ? (
        <div className="space-y-6">
          <section className="bg-slate-800/40 border border-slate-800 p-4 rounded-lg grid grid-cols-2 gap-3 text-sm">
            <Meta label="kind" value={a.kind} mono />
            <Meta label="ts" value={new Date(a.ts * 1000).toLocaleString()} />
            <Meta label="project" value={a.project_id} />
            <Meta
              label="session"
              value={
                a.session_id ? (
                  <Link
                    to={`/brain/session/${a.session_id}?org_id=${orgId}`}
                    className="text-blue-400 hover:underline"
                  >
                    {a.session_id}
                  </Link>
                ) : (
                  "—"
                )
              }
            />
            <Meta label="origin" value={`${a.origin.tool} / ${a.origin.actor ?? "—"}`} />
            <Meta label="size" value={`${a.size} bytes`} />
            <Meta label="content_type" value={a.content_type ?? "—"} />
            <Meta label="schema_version" value={String(a.schema_version)} />
          </section>

          <section>
            <h2 className="text-sm font-semibold mb-2">Content</h2>
            <ArtifactContent artifact={a} />
          </section>

          {a.kind_specific_meta !== null && (
            <section>
              <h2 className="text-sm font-semibold mb-2">kind_specific_meta</h2>
              <JsonTree data={a.kind_specific_meta} />
            </section>
          )}

          {a.edges && (
            <section>
              <h2 className="text-sm font-semibold mb-2">Edges</h2>
              <div className="grid md:grid-cols-2 gap-3 text-xs">
                <EdgeList title="incoming" edges={a.edges.incoming} hashKey="from_hash" orgId={orgId} />
                <EdgeList title="outgoing" edges={a.edges.outgoing} hashKey="to_hash" orgId={orgId} />
              </div>
            </section>
          )}

          {a.ingest_event !== undefined && (
            <section>
              <h2 className="text-sm font-semibold mb-2">ingest_event</h2>
              <JsonTree data={a.ingest_event} />
            </section>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Meta({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-sm ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

/**
 * Pick a human-readable title for the hero. Prefer first non-empty line of
 * utf8 content; fall back to the kind label for binary or empty content.
 */
function deriveArtifactTitle(a: BrainArtifactT): string {
  if (a.content_encoding === "utf8" && typeof a.content === "string") {
    const firstLine = a.content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (firstLine) {
      return firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine;
    }
  }
  return a.kind;
}

/**
 * Content renderer that branches on `kind` + `content_type`. Falls back to
 * a monospace pre tag for unknown kinds, which keeps existing behaviour
 * for everything outside the explicit branches below.
 */
function ArtifactContent({ artifact }: { artifact: BrainArtifactT }): React.ReactElement {
  const { kind, content, content_encoding, content_type } = artifact;

  if (content === null || content === undefined) {
    return <PreBlock>(no content)</PreBlock>;
  }

  // Image: kind = media/image/*, content stored base64. Use content_type for
  // the data URI mime when available, otherwise default to png — most of our
  // ingested screenshots are png.
  if (kind.startsWith("media/image/") && content_encoding === "base64") {
    const mime = content_type ?? "image/png";
    return (
      <div className="bg-slate-950 border border-slate-800 p-3 rounded">
        <img
          src={`data:${mime};base64,${content}`}
          alt={kind}
          className="max-w-full max-h-[600px] rounded border border-slate-800"
        />
        <div className="mt-2 text-[10px] text-slate-500 font-mono">
          {mime} · {artifact.size} bytes
        </div>
      </div>
    );
  }

  // reference/link — if content is a single-line URL, render as an external
  // anchor. Otherwise drop through to the default pre block.
  if (kind === "reference/link" && content_encoding === "utf8") {
    const trimmed = content.trim();
    if (/^https?:\/\/\S+$/.test(trimmed) && !trimmed.includes("\n")) {
      return (
        <div className="bg-slate-950 border border-slate-800 p-3 rounded text-sm">
          <a
            href={trimmed}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:underline break-all"
          >
            {trimmed}
          </a>
        </div>
      );
    }
  }

  // JSON payloads render as a collapsible tree (name fields readable at a
  // glance) rather than a stringified blob. Applies when the kind/type says
  // JSON, or when the content is parseable JSON (tool_call payloads etc.).
  // Bail to the raw pre on parse failure.
  if (content_encoding === "utf8") {
    const jsonish =
      kind === "data/json" ||
      content_type === "application/json" ||
      /^\s*[{[]/.test(content);
    if (jsonish) {
      try {
        return <JsonTree data={JSON.parse(content)} />;
      } catch {
        // fall through — not actually JSON (or truncated)
      }
    }
  }

  // Conversation prose (user/assistant messages, summaries) is markdown —
  // render it instead of dumping ## **syntax** at the user.
  if (
    content_encoding === "utf8" &&
    (kind.startsWith("conversation/turn/") || kind.startsWith("conversation/summary"))
  ) {
    return (
      <div className="bg-slate-950 border border-slate-800 p-3 rounded">
        <Markdown>{content}</Markdown>
      </div>
    );
  }

  // code/* — render with a small language hint badge. The suffix after the
  // last "/" maps directly to a language label for the badge (e.g.
  // code/blob/ts → "ts", code/diff → "diff").
  if (kind.startsWith("code/") && content_encoding === "utf8") {
    const language = kind.split("/").pop() ?? "code";
    return <CodeBlock language={language} code={content} />;
  }

  // Binary fallback — content is base64 but we have no specialised renderer
  // for the kind. Avoid dumping base64 garbage at the user.
  if (content_encoding === "base64") {
    return <PreBlock>[binary content — base64 omitted]</PreBlock>;
  }

  // Default: utf8 text in a monospace block.
  return <PreBlock>{content}</PreBlock>;
}

function PreBlock({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <pre className="bg-slate-950 border border-slate-800 p-3 rounded overflow-x-auto text-xs whitespace-pre-wrap break-words">
      {children}
    </pre>
  );
}

function CodeBlock({
  language,
  code,
}: {
  language: string;
  code: string;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // ignore — visual nudge below still confirms the action
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="bg-slate-950 border border-slate-800 rounded overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-800 bg-slate-900/60">
        <span className="text-[10px] uppercase tracking-wider text-slate-500 font-mono">
          {language}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-600">
            {code.length.toLocaleString()} chars
          </span>
          <button
            type="button"
            onClick={handleCopy}
            className="text-[10px] uppercase tracking-wider text-slate-500 hover:text-slate-200 px-1.5 py-0.5 rounded border border-slate-800 hover:border-slate-600"
          >
            {copied ? "copied ✓" : "copy"}
          </button>
        </div>
      </div>
      <pre className="p-3 overflow-x-auto text-xs whitespace-pre-wrap break-words font-mono leading-5">
        {code}
      </pre>
    </div>
  );
}

function EdgeList({
  title,
  edges,
  hashKey,
  orgId,
}: {
  title: string;
  edges: Array<{ relation: string; scope: string; from_hash?: string; to_hash?: string }>;
  hashKey: "from_hash" | "to_hash";
  orgId: string;
}): React.ReactElement {
  return (
    <div className="bg-slate-800/40 border border-slate-800 p-3 rounded">
      <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">{title}</div>
      {edges.length === 0 ? (
        <div className="text-slate-500">—</div>
      ) : (
        <ul className="space-y-1">
          {edges.map((e, i) => {
            const h = (e as unknown as Record<string, string>)[hashKey];
            return (
              <li key={`${h}-${e.relation}-${i}`}>
                <Link
                  to={`/brain/artifact/${h}?org_id=${orgId}`}
                  className="font-mono text-blue-400 hover:underline"
                >
                  {h?.slice(0, 10)}…
                </Link>
                <span className="ml-2 text-slate-500">[{e.relation}]</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
