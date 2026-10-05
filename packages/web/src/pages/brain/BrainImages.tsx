import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { humanizeApiError } from "../../lib/humanize-error";
import {
  brainListImages,
  type BrainImageItem,
  type BrainImageCluster,
} from "../../lib/brainApi";
import { useOrgProject } from "../../components/OrgProjectPicker";
import { LazyThumbnail } from "../../components/LazyThumbnail";

const SCENES = ["", "ui", "terminal", "diagram", "chart", "photo", "code", "whiteboard"];

export function BrainImages(): React.ReactElement {
  const { scope } = useOrgProject();
  const { orgId, projectId } = scope;
  const [scene, setScene] = useState("");
  const [ocrQuery, setOcrQuery] = useState("");
  const [doCluster, setDoCluster] = useState(false);
  const [items, setItems] = useState<BrainImageItem[]>([]);
  const [clusters, setClusters] = useState<BrainImageCluster[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Phase 12 (UI review H2) — preview state lifts the clicked thumbnail
  // into a lightbox so users can inspect a screenshot without leaving
  // the grid. Click the dimmed background (or hit Esc) to close.
  const [preview, setPreview] = useState<BrainImageItem | null>(null);

  async function load() {
    if (!projectId) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await brainListImages({
        org_id: orgId,
        project_id: projectId,
        scene_class: scene || undefined,
        ocr_query: ocrQuery || undefined,
        cluster: doCluster ? "phash" : "none",
        limit: 120,
      });
      setItems(r.items);
      setClusters(r.clusters);
    } catch (e) {
      setErr(humanizeApiError(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, projectId, scene, ocrQuery, doCluster]);

  // Esc closes the lightbox.
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreview(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

  return (
    <div className="p-6 space-y-4 text-slate-200">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Images</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {items.length} image{items.length === 1 ? "" : "s"}
            {scene && (
              <>
                {" "}
                · scene <span className="font-mono">{scene}</span>
              </>
            )}
            {ocrQuery && (
              <>
                {" "}
                · OCR contains <span className="font-mono">{ocrQuery}</span>
              </>
            )}
          </p>
        </div>
      </div>

      <section className="flex flex-wrap gap-3 items-end bg-slate-800/50 p-4 rounded-lg">
        <Field label="Scene">
          <select
            value={scene}
            onChange={(e) => setScene(e.target.value)}
            className={inputCls}
          >
            {SCENES.map((s) => (
              <option key={s} value={s}>
                {s || "(any)"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="OCR contains">
          <input
            value={ocrQuery}
            onChange={(e) => setOcrQuery(e.target.value)}
            className={inputCls}
            placeholder="error 502"
          />
        </Field>
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={doCluster}
            onChange={(e) => setDoCluster(e.target.checked)}
          />
          Group near-dup (pHash)
        </label>
      </section>

      {err && (
        <div role="alert" className="text-red-400 bg-red-950/30 border border-red-900 p-3 rounded">
          {err}
        </div>
      )}

      {loading ? (
        <ImageGridSkeleton />
      ) : doCluster && clusters ? (
        <div className="space-y-3">
          {clusters.map((c) => {
            const repItem = items.find((i) => i.hash === c.representative);
            const tiles = c.hashes
              .map((h) => items.find((i) => i.hash === h))
              .filter((i): i is BrainImageItem => Boolean(i));
            return (
              <div
                key={c.representative}
                className="bg-slate-800/40 border border-slate-800 rounded-lg p-3"
              >
                <div className="flex items-baseline gap-2 text-xs text-slate-400 mb-2">
                  <span className="font-medium text-slate-300">
                    {c.size} image{c.size === 1 ? "" : "s"}
                  </span>
                  {repItem?.scene_class && (
                    <span className="px-1.5 py-0.5 bg-slate-900 rounded font-mono text-[10px] text-slate-400">
                      {repItem.scene_class}
                    </span>
                  )}
                  {repItem?.caption && (
                    <span className="text-slate-500 truncate">{repItem.caption}</span>
                  )}
                </div>
                <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(140px,1fr))]">
                  {tiles.slice(0, 12).map((item) => (
                    <ImageTile
                      key={item.hash}
                      item={item}
                      orgId={orgId}
                      onPreview={() => setPreview(item)}
                    />
                  ))}
                  {tiles.length > 12 && (
                    <div className="self-center text-xs text-slate-500 pl-1">
                      + {tiles.length - 12} more
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
          {items.map((item) => (
            <ImageTile
              key={item.hash}
              item={item}
              orgId={orgId}
              onPreview={() => setPreview(item)}
            />
          ))}
          {!items.length && !loading && (
            <div className="text-slate-500 text-sm col-span-full">
              no images yet — capture some, or run image extractors
            </div>
          )}
        </div>
      )}

      {preview && <Lightbox item={preview} orgId={orgId} onClose={() => setPreview(null)} />}
    </div>
  );
}

function ImageTile({
  item,
  orgId,
  onPreview,
}: {
  item: BrainImageItem;
  orgId: string;
  onPreview: () => void;
}): React.ReactElement {
  return (
    <div className="group bg-slate-800/40 border border-slate-800 rounded-lg overflow-hidden hover:border-slate-600 transition-colors">
      <button
        type="button"
        onClick={onPreview}
        className="block w-full text-left"
        aria-label={`Preview ${item.scene_class ?? "image"}`}
      >
        <LazyThumbnail
          hash={item.hash}
          orgId={orgId}
          alt={item.caption ?? item.scene_class ?? item.hash}
          aspect="square"
          fit="cover"
          className="bg-slate-950"
        />
      </button>
      <div className="p-2 space-y-1">
        <div className="flex items-center gap-1.5 text-[10px]">
          {item.scene_class && (
            <span className="px-1.5 py-0.5 bg-slate-900 rounded font-mono text-slate-400">
              {item.scene_class}
            </span>
          )}
          <span className="text-slate-600 ml-auto">
            {new Date(item.ts * 1000).toLocaleDateString()}
          </span>
        </div>
        {item.caption && (
          <div className="text-xs text-slate-300 line-clamp-2 leading-snug">
            {item.caption}
          </div>
        )}
        {item.ocr_text && (
          <div className="text-[10px] text-slate-500 line-clamp-1 italic">
            “{item.ocr_text}”
          </div>
        )}
        <Link
          to={`/brain/artifact/${item.hash}?org_id=${orgId}`}
          className="block text-[10px] text-blue-400 hover:underline pt-0.5"
        >
          open artifact →
        </Link>
      </div>
    </div>
  );
}

function Lightbox({
  item,
  orgId,
  onClose,
}: {
  item: BrainImageItem;
  orgId: string;
  onClose: () => void;
}): React.ReactElement {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-slate-900 border border-slate-800 rounded-xl max-w-5xl max-h-[90vh] w-full overflow-hidden flex flex-col"
      >
        <div className="flex items-baseline justify-between p-3 border-b border-slate-800 gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-slate-100 truncate">
              {item.caption ?? item.scene_class ?? item.hash.slice(0, 16)}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              {new Date(item.ts * 1000).toLocaleString()}
              {item.width && item.height && (
                <>
                  {" "}
                  · {item.width}×{item.height}
                </>
              )}
              {item.scene_class && (
                <>
                  {" "}
                  · <span className="font-mono">{item.scene_class}</span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Link
              to={`/brain/artifact/${item.hash}?org_id=${orgId}`}
              className="text-xs text-blue-400 hover:underline"
            >
              open artifact →
            </Link>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-slate-500 hover:text-white px-2"
            >
              ✕
            </button>
          </div>
        </div>
        <div className="flex-1 bg-black/40 flex items-center justify-center overflow-auto p-2">
          <LazyThumbnail
            hash={item.hash}
            orgId={orgId}
            alt={item.caption ?? item.hash}
            aspect="auto"
            fit="contain"
            className="w-full max-h-[75vh] flex items-center justify-center"
          />
        </div>
        {item.ocr_text && (
          <div className="border-t border-slate-800 p-3 text-xs text-slate-400 max-h-32 overflow-y-auto whitespace-pre-wrap">
            <span className="text-slate-500">OCR:</span> {item.ocr_text}
          </div>
        )}
      </div>
    </div>
  );
}

function ImageGridSkeleton(): React.ReactElement {
  return (
    <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
      {Array.from({ length: 12 }).map((_, i) => (
        <div
          key={i}
          className="bg-slate-800/40 border border-slate-800 rounded-lg overflow-hidden"
        >
          <div className="aspect-square bg-slate-900 animate-pulse" />
          <div className="p-2 space-y-1">
            <div className="h-3 w-1/2 bg-slate-800 rounded animate-pulse" />
            <div className="h-3 w-3/4 bg-slate-800 rounded animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

const inputCls =
  "bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}
