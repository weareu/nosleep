/**
 * Brain Capture (web) — voice-or-text note that routes to either the
 * brain archive (default) or the project's strategy tree as a child of
 * the next-actionable node (or any node the user picks). Mirrors the
 * mobile BrainCaptureScreen feature-for-feature: live STT via the
 * browser's SpeechRecognition API, m4a/webm recording via MediaRecorder,
 * audio artifact link on the captured thought, and a parent picker for
 * the strategy path.
 *
 * STT support: Chrome / Edge (webkitSpeechRecognition) and Safari 14+
 * (SpeechRecognition). Firefox has no native STT — the mic button still
 * records audio, but the user has to type the note themselves.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useOrgProject, ORG_LEVEL } from "../../components/OrgProjectPicker";
import { DocumentDropZone } from "./DocumentDropZone";
import { UrlCapturePanel } from "./UrlCapturePanel";
import {
  captureThought,
  ingestAudio,
} from "../../lib/brainApi";
import {
  createNode,
  fetchStrategyTree,
  getNextActionable,
} from "../../lib/api";

// Local shapes for what fetchStrategyTree returns — the canonical type
// isn't exported from `lib/api.ts`, but we only need a tiny subset here
// (id, parentId, title, type, status) for the parent picker.
interface MinimalStrategyTree {
  nodes?: Array<{
    id: string;
    parentId: string | null;
    title: string;
    type: string;
    status: string;
  }>;
}

// ── Speech recognition (browser) ───────────────────────────────────

interface SpeechRecognitionLike {
  start(): void;
  stop(): void;
  abort(): void;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechResultEventLike) => void) | null;
  onerror: ((event: { error?: string; message?: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechResultEventLike {
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
  resultIndex: number;
}

interface SpeechRecognitionCtor {
  new (): SpeechRecognitionLike;
}

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// ── Audio recording ────────────────────────────────────────────────

interface ActiveRecording {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  startedAt: number;
}

async function startAudioRecording(): Promise<ActiveRecording | null> {
  if (!navigator.mediaDevices?.getUserMedia) return null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Pick whichever MIME the browser supports. webm/opus is universal in
    // Chrome/Edge/Firefox; mp4/aac is Safari. The server accepts either.
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";
    const recorder = new MediaRecorder(
      stream,
      mime ? { mimeType: mime } : undefined,
    );
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.start();
    return { recorder, stream, chunks, startedAt: Date.now() };
  } catch {
    return null;
  }
}

interface AudioCapture {
  blob: Blob;
  contentType: string;
  durationMs: number;
}

async function stopAudioRecording(
  active: ActiveRecording,
): Promise<AudioCapture> {
  return new Promise((resolve) => {
    active.recorder.onstop = () => {
      for (const t of active.stream.getTracks()) t.stop();
      const blob = new Blob(active.chunks, {
        type: active.recorder.mimeType || "audio/webm",
      });
      resolve({
        blob,
        contentType: blob.type || "audio/webm",
        durationMs: Date.now() - active.startedAt,
      });
    };
    active.recorder.stop();
  });
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      const comma = dataUrl.indexOf(",");
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ── Strategy parent picker (compact, inline) ───────────────────────

interface FlatTreeRow {
  id: string;
  parentId: string | null;
  title: string;
  type: string;
  status: string;
  depth: number;
}

function flattenTree(tree: MinimalStrategyTree | null): FlatTreeRow[] {
  if (!tree) return [];
  const nodes = tree.nodes ?? [];
  const childrenOf = new Map<string | null, typeof nodes>();
  for (const n of nodes) {
    const arr = childrenOf.get(n.parentId) ?? [];
    arr.push(n);
    childrenOf.set(n.parentId, arr);
  }
  const out: FlatTreeRow[] = [];
  function walk(parentId: string | null, depth: number): void {
    const kids = childrenOf.get(parentId) ?? [];
    for (const k of kids) {
      out.push({
        id: k.id,
        parentId: k.parentId,
        title: k.title,
        type: k.type,
        status: k.status,
        depth,
      });
      walk(k.id, depth + 1);
    }
  }
  walk(null, 0);
  return out;
}

// ── Main page ──────────────────────────────────────────────────────

export function BrainCapture(): React.ReactElement {
  const { scope } = useOrgProject();
  const { orgId, projectId } = scope;
  const realProject = projectId !== ORG_LEVEL && projectId.length > 0;

  const [content, setContent] = useState("");
  const [destination, setDestination] = useState<"brain" | "strategy">("brain");
  const [recording, setRecording] = useState(false);
  const [audioReady, setAudioReady] = useState<AudioCapture | null>(null);
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(
    null,
  );

  // Strategy parent override: undefined = auto, null = root, string = node id.
  const [strategyParent, setStrategyParent] = useState<
    string | null | undefined
  >(undefined);
  const [tree, setTree] = useState<MinimalStrategyTree | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const activeRecordingRef = useRef<ActiveRecording | null>(null);
  const contentPrefixRef = useRef<string>("");

  const flat = useMemo(() => flattenTree(tree), [tree]);

  useEffect(() => {
    if (destination !== "strategy" || !realProject) {
      setTree(null);
      return;
    }
    fetchStrategyTree(projectId)
      .then((t) => setTree(t as unknown as MinimalStrategyTree))
      .catch(() => setTree(null));
  }, [destination, realProject, projectId]);

  const sttSupported = getSpeechRecognitionCtor() !== null;
  const audioSupported =
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia);

  const showToast = useCallback(
    (msg: string, kind: "ok" | "err" = "ok", ms = 3_000) => {
      setToast({ kind, msg });
      window.setTimeout(() => setToast(null), ms);
    },
    [],
  );

  const stopMic = useCallback(async (): Promise<void> => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    if (activeRecordingRef.current) {
      const result = await stopAudioRecording(activeRecordingRef.current);
      activeRecordingRef.current = null;
      setAudioReady(result);
    }
    setRecording(false);
  }, []);

  async function startMic(): Promise<void> {
    if (!sttSupported && !audioSupported) {
      showToast("Mic / speech recognition not supported in this browser", "err");
      return;
    }
    setAudioReady(null);
    contentPrefixRef.current =
      content.trim().length > 0 ? content.trim() + " " : "";

    // Start audio capture first so it's ready before STT begins to fire.
    if (audioSupported) {
      const rec = await startAudioRecording();
      if (rec) activeRecordingRef.current = rec;
    }

    // Live transcript via Web Speech API where available.
    const Ctor = getSpeechRecognitionCtor();
    if (Ctor) {
      const rec = new Ctor();
      rec.lang = navigator.language || "en-US";
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (ev) => {
        let full = "";
        for (let i = 0; i < ev.results.length; i++) {
          full += ev.results[i][0].transcript;
        }
        setContent(contentPrefixRef.current + full);
      };
      rec.onerror = (e) => {
        showToast("Voice error: " + (e.message ?? e.error ?? "unknown"), "err");
      };
      rec.onend = () => {
        // If we get an unexpected end (e.g. silence timeout) while the
        // user thinks they're still recording, surface it so they hit
        // record again to keep going.
        if (recognitionRef.current) {
          recognitionRef.current = null;
          setRecording(false);
        }
      };
      recognitionRef.current = rec;
      try {
        rec.start();
      } catch {
        recognitionRef.current = null;
      }
    }
    setRecording(true);
  }

  async function onMicClick(): Promise<void> {
    if (recording) {
      await stopMic();
    } else {
      await startMic();
    }
  }

  useEffect(() => {
    return () => {
      // Always stop on unmount so the mic doesn't keep streaming.
      void stopMic();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSend(): Promise<void> {
    const text = content.trim();
    if (!text) return;
    setSending(true);
    try {
      if (destination === "strategy") {
        if (!realProject) {
          showToast("Pick a real project to send to Strategy", "err");
          return;
        }
        let parentId: string | null = null;
        if (strategyParent === undefined) {
          try {
            const next = await getNextActionable(projectId);
            parentId = (next as { id?: string } | null)?.id ?? null;
          } catch {
            /* fall back to root */
          }
        } else {
          parentId = strategyParent;
        }
        const title = text.length <= 60 ? text : text.slice(0, 57) + "…";
        await createNode({
          projectId,
          orgId,
          parentId,
          type: "subtask",
          title,
          description: text,
        });
        showToast(parentId ? "Sent to Strategy (child)" : "Sent to Strategy (root)");
      } else {
        const refs: Array<{ hash: string; relation: string }> = [];
        let audioError: string | null = null;
        if (audioReady) {
          const b64 = await blobToBase64(audioReady.blob);
          try {
            const art = await ingestAudio({
              base64: b64,
              content_type: audioReady.contentType,
              org_id: orgId,
              project_id: projectId,
              duration_ms: audioReady.durationMs,
              transcript: text,
            });
            refs.push({ hash: art.hash, relation: "recorded_as" });
          } catch (e) {
            // Non-fatal — the note still captures — but say so.
            audioError = e instanceof Error ? e.message : String(e);
          }
        }
        await captureThought({
          content: text,
          org_id: orgId,
          project_id: projectId,
          source_kind: "web_note",
          source_refs: refs.length > 0 ? refs : undefined,
        });
        if (audioError) {
          showToast(`Captured to Brain, but the recording failed to upload: ${audioError}`, "err", 6_000);
        } else {
          showToast("Captured to Brain");
        }
      }
      setContent("");
      setAudioReady(null);
    } catch (e) {
      showToast(
        "Send failed: " + (e instanceof Error ? e.message : String(e)),
        "err",
        5_000,
      );
    } finally {
      setSending(false);
    }
  }

  const canSend = content.trim().length > 0 && !sending;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 text-slate-100">
      <h1 className="text-xl font-semibold mb-1">Capture a thought</h1>
      <p className="text-sm text-slate-400 mb-4">
        Speak or type, upload documents, or capture a URL. Send to the Brain
        archive or attach as a strategy-tree note.
      </p>

      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="What's worth remembering?"
          className="w-full min-h-[160px] bg-slate-950 border border-slate-800 rounded p-3 text-sm placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/60 resize-y"
        />

        <div className="flex flex-wrap items-center gap-2 mt-3">
          <button
            type="button"
            onClick={onMicClick}
            disabled={!sttSupported && !audioSupported}
            className={
              "px-3 py-2 rounded text-sm font-medium border transition " +
              (recording
                ? "bg-red-500 border-red-500 text-white"
                : "bg-slate-800 border-slate-700 text-slate-100 hover:bg-slate-700")
            }
          >
            {recording ? "⏺ Stop" : "🎤 Record"}
          </button>
          {audioReady && !recording && (
            <button
              type="button"
              onClick={() => setAudioReady(null)}
              className="px-2 py-1 rounded-full text-xs bg-blue-500/15 border border-blue-500/50 text-blue-300"
            >
              🎤 {(audioReady.durationMs / 1000).toFixed(1)}s · ✕
            </button>
          )}
          {!sttSupported && (
            <span className="text-xs text-slate-500">
              (live transcript not supported in this browser — audio still records)
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 mt-4">
          <button
            type="button"
            onClick={() => setDestination("brain")}
            className={
              "py-2 rounded text-sm font-medium border " +
              (destination === "brain"
                ? "bg-blue-500/15 border-blue-500 text-blue-300"
                : "bg-slate-800 border-slate-700 text-slate-300")
            }
          >
            🧠 Brain
          </button>
          <button
            type="button"
            onClick={() => setDestination("strategy")}
            className={
              "py-2 rounded text-sm font-medium border " +
              (destination === "strategy"
                ? "bg-blue-500/15 border-blue-500 text-blue-300"
                : "bg-slate-800 border-slate-700 text-slate-300")
            }
          >
            🎯 Strategy
          </button>
        </div>

        {destination === "strategy" && (
          <div className="mt-3">
            {!realProject ? (
              <div className="text-xs text-amber-400">
                Pick a real project (top of page) to send to the strategy tree.
              </div>
            ) : (
              <label className="block text-xs uppercase tracking-wider text-slate-500">
                Parent node
                <select
                  className="block w-full mt-1 bg-slate-950 border border-slate-800 rounded p-2 text-sm"
                  value={
                    strategyParent === undefined
                      ? "__auto__"
                      : strategyParent === null
                        ? "__root__"
                        : strategyParent
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "__auto__") setStrategyParent(undefined);
                    else if (v === "__root__") setStrategyParent(null);
                    else setStrategyParent(v);
                  }}
                >
                  <option value="__auto__">auto — next actionable</option>
                  <option value="__root__">(root — no parent)</option>
                  {flat.map((n) => (
                    <option key={n.id} value={n.id}>
                      {" ".repeat(n.depth * 2)}
                      {n.title} · {n.type} · {n.status}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          className={
            "block w-full mt-4 py-3 rounded text-sm font-semibold " +
            (canSend
              ? "bg-blue-500 hover:bg-blue-600 text-white"
              : "bg-slate-800 text-slate-500 cursor-not-allowed")
          }
        >
          {sending
            ? destination === "strategy"
              ? "Sending…"
              : "Capturing…"
            : destination === "strategy"
              ? "Send to Strategy"
              : "Capture to Brain"}
        </button>

        {toast && (
          <div
            role="status"
            className={
              "mt-3 text-sm rounded px-3 py-2 " +
              (toast.kind === "ok"
                ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
                : "bg-red-500/10 text-red-300 border border-red-500/30")
            }
          >
            {toast.msg}
          </div>
        )}
      </div>

      <DocumentDropZone orgId={orgId} projectId={projectId} />
      <UrlCapturePanel orgId={orgId} projectId={projectId} />
    </div>
  );
}
