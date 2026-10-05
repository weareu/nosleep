import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { humanizeApiError } from "../../lib/humanize-error";
import { looksLikeJson } from "../../lib/smart-json";
import { Markdown } from "../../components/Markdown";
import { SmartSnippet } from "../../components/SmartSnippet";
import {
  brainGetSessionArtifacts,
  type BrainSessionArtifactsResponse,
} from "../../lib/brainApi";
import {
  BrainDetailHero,
  BrainDetailToolbar,
  CodeIcon,
  CopyIcon,
  GraphIcon,
} from "../../components/BrainDetailHero";
import { JsonViewerModal } from "../../components/JsonViewerModal";

export function BrainSession(): React.ReactElement {
  const { sessionId = "" } = useParams();
  const [params] = useSearchParams();
  const orgId =
    params.get("org") ?? params.get("org_id") ?? "org_personal";

  const [data, setData] = useState<BrainSessionArtifactsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    brainGetSessionArtifacts(sessionId, orgId, { limit: 200, order: "asc" })
      .then(setData)
      .catch((e) => setErr(humanizeApiError(e)))
      .finally(() => setLoading(false));
  }, [sessionId, orgId]);

  const itemCount = data?.items.length ?? 0;
  const firstTs = data?.items[0]?.ts;
  const lastTs = data?.items[data.items.length - 1]?.ts;

  return (
    <div className="p-6 space-y-4 text-slate-200">
      <BrainDetailToolbar
        actions={[
          {
            label: "Copy session id",
            icon: <CopyIcon />,
            onClick: () => navigator.clipboard.writeText(sessionId).catch(() => {}),
          },
          {
            label: "Open in app",
            icon: <GraphIcon />,
            to: `/sessions/${sessionId}`,
          },
          {
            label: "Raw JSON",
            icon: <CodeIcon />,
            onClick: () => setShowJson(true),
            disabled: !data,
          },
        ]}
      />

      <JsonViewerModal
        open={showJson}
        onClose={() => setShowJson(false)}
        title={`Session ${sessionId.slice(0, 12)}${sessionId.length > 12 ? "…" : ""}`}
        data={data}
      />

      <BrainDetailHero
        eyebrow="Session Replay"
        title={`${itemCount} artifact${itemCount === 1 ? "" : "s"}`}
        subtitle={
          firstTs && lastTs ? (
            <>
              <span className="font-mono text-slate-400">{orgId}</span>
              <span>·</span>
              <span>
                from {new Date(firstTs * 1000).toLocaleString()} to{" "}
                {new Date(lastTs * 1000).toLocaleString()}
              </span>
            </>
          ) : (
            <span className="font-mono text-slate-400">{orgId}</span>
          )
        }
        identifier={sessionId}
      />

      {err && (
        <div role="alert" className="text-red-400 bg-red-950/30 border border-red-900 p-3 rounded">
          {err}
        </div>
      )}

      {loading ? (
        <div className="text-slate-400">loading…</div>
      ) : data && data.items.length > 0 ? (
        <ol className="space-y-2">
          {data.items.map((item, i) => (
            <li
              key={item.hash}
              className="flex gap-3 bg-slate-800/40 border border-slate-800 p-3 rounded"
            >
              <div className="text-xs text-slate-500 font-mono shrink-0 w-20">
                {item.turn_ord ?? i + 1}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs mb-1">
                  <span className="font-mono bg-slate-900 px-1.5 py-0.5 rounded text-slate-300">
                    {item.kind}
                  </span>
                  <span className="text-slate-500">
                    {new Date(item.ts * 1000).toLocaleString()}
                  </span>
                  {item.actor && <span className="text-slate-500">· {item.actor}</span>}
                  <span className="text-slate-500">· {item.size} bytes</span>
                </div>
                <div className="text-sm text-slate-300 break-words">
                  {!item.snippet ? (
                    "(no text)"
                  ) : looksLikeJson(item.snippet) ? (
                    <SmartSnippet text={item.snippet} />
                  ) : (
                    <Markdown>{item.snippet}</Markdown>
                  )}
                </div>
                <Link
                  to={`/brain/artifact/${item.hash}?org_id=${orgId}`}
                  className="text-xs text-blue-400 hover:underline mt-1 inline-block"
                >
                  open artifact →
                </Link>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <div className="text-slate-500 text-sm">no artifacts for this session</div>
      )}
    </div>
  );
}
