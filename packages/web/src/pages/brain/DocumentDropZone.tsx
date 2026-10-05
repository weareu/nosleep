/**
 * Document upload for Brain Capture — file picker + drag-and-drop. Each file
 * goes to POST /api/brain/ingest/file (base64 JSON, same encoding as the
 * mobile photo/voice uploads) and shows its own status + artifact link.
 */

import { useCallback, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  BRAIN_UPLOAD_ACCEPT,
  BRAIN_UPLOAD_MAX_BYTES,
  ingestBrainFile,
  type BrainFileIngestResult,
} from "../../lib/brainApi";

type UploadState =
  | { status: "reading" | "uploading" }
  | { status: "done"; result: BrainFileIngestResult }
  | { status: "error"; message: string };

interface UploadRow {
  id: number;
  name: string;
  size: number;
  state: UploadState;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = String(reader.result ?? "");
      const comma = dataUrl.indexOf(",");
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
    };
    reader.onerror = () => reject(reader.error ?? new Error("could not read file"));
    reader.readAsDataURL(file);
  });
}

const ACCEPTED_EXTS = new Set(BRAIN_UPLOAD_ACCEPT.split(","));

/** Files with a recognised-but-unsupported extension are rejected before
 *  upload; files without an extension go to the server, which decides by
 *  content type (it stays the authority either way). */
function unsupportedExtension(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot).toLowerCase();
  return ACCEPTED_EXTS.has(ext) ? null : ext;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function describeResult(r: BrainFileIngestResult): string {
  const parts = [r.kind];
  if (r.page_count !== undefined) {
    parts.push(`${r.pages?.length ?? 0}/${r.page_count} pages searchable`);
  }
  if (r.duplicate) parts.push("already in Brain");
  return parts.join(" · ");
}

export function DocumentDropZone(props: {
  orgId: string;
  projectId: string;
}): React.ReactElement {
  const { orgId, projectId } = props;
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const nextId = useRef(1);

  const update = useCallback((id: number, state: UploadState) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, state } : r)));
  }, []);

  const uploadOne = useCallback(
    async (file: File, id: number) => {
      const badExt = unsupportedExtension(file.name);
      if (badExt) {
        update(id, {
          status: "error",
          message: `unsupported type ${badExt} — use PDF, Markdown/text, JSON/YAML/CSV, source code or PNG/JPEG/GIF/WebP`,
        });
        return;
      }
      if (file.size > BRAIN_UPLOAD_MAX_BYTES) {
        update(id, {
          status: "error",
          message: `too large (${formatBytes(file.size)}; max ${formatBytes(BRAIN_UPLOAD_MAX_BYTES)})`,
        });
        return;
      }
      try {
        const b64 = await fileToBase64(file);
        update(id, { status: "uploading" });
        const result = await ingestBrainFile({
          filename: file.name,
          content_type: file.type,
          content_base64: b64,
          org_id: orgId,
          project_id: projectId,
        });
        update(id, { status: "done", result });
      } catch (e) {
        update(id, { status: "error", message: e instanceof Error ? e.message : String(e) });
      }
    },
    [orgId, projectId, update],
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      const added = list.map((f) => ({
        id: nextId.current++,
        name: f.name,
        size: f.size,
        state: { status: "reading" } as UploadState,
      }));
      setRows((prev) => [...added, ...prev]);
      // Sequential: keeps the server's PDF parsing one file at a time.
      void (async () => {
        for (let i = 0; i < list.length; i++) {
          await uploadOne(list[i], added[i].id);
        }
      })();
    },
    [uploadOne],
  );

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 mt-4">
      <div className="text-sm font-semibold mb-1">Upload documents</div>
      <div
        role="button"
        tabIndex={0}
        aria-label="Drop files here or click to choose files"
        data-testid="brain-drop-zone"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        className={
          "rounded border-2 border-dashed px-4 py-6 text-center text-sm cursor-pointer transition " +
          (dragging
            ? "border-blue-500 bg-blue-500/10 text-blue-300"
            : "border-slate-700 bg-slate-950 text-slate-400 hover:border-slate-600")
        }
      >
        Drop files here, or click to choose
        <div className="text-xs text-slate-500 mt-1">
          PDF (per-page searchable text) · Markdown / text / JSON / YAML / CSV · source code ·
          PNG / JPEG / GIF / WebP — up to {formatBytes(BRAIN_UPLOAD_MAX_BYTES)} each
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={BRAIN_UPLOAD_ACCEPT}
        className="hidden"
        data-testid="brain-file-input"
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {rows.length > 0 && (
        <ul className="mt-3 space-y-1" aria-live="polite">
          {rows.map((r) => (
            <li
              key={r.id}
              data-testid="brain-upload-row"
              data-status={r.state.status}
              className="flex flex-wrap items-center gap-2 text-sm rounded border border-slate-800 bg-slate-950 px-3 py-2"
            >
              <span className="font-medium text-slate-200 truncate max-w-[16rem]">{r.name}</span>
              <span className="text-xs text-slate-500">{formatBytes(r.size)}</span>
              <span className="ml-auto text-xs">
                {r.state.status === "reading" && <span className="text-slate-400">reading…</span>}
                {r.state.status === "uploading" && <span className="text-blue-300">uploading…</span>}
                {r.state.status === "error" && <span className="text-red-300">{r.state.message}</span>}
                {r.state.status === "done" && (
                  <span className="text-emerald-300">
                    {describeResult(r.state.result)} ·{" "}
                    <Link
                      className="underline hover:text-emerald-200"
                      to={`/brain/artifact/${r.state.result.hash}?org_id=${encodeURIComponent(orgId)}`}
                    >
                      open
                    </Link>
                  </span>
                )}
              </span>
              {r.state.status === "done" && r.state.result.warnings.length > 0 && (
                <div className="w-full text-xs text-amber-400">{r.state.result.warnings.join("; ")}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
