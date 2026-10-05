/**
 * Phase 12 (UI review H2) — minimal toast + undo system.
 *
 * Pattern: a parent calls `useToasts()` to get `{ toasts, push, dismiss }`.
 * Optimistic actions push a toast with an `undo` callback; clicking Undo
 * fires the callback (re-add the row, re-POST a reject, etc) and the
 * toast leaves. Auto-dismisses after 4s if the user does nothing.
 *
 * No global state, no portals, no deps — each consumer owns its toast
 * stack. Render `<ToastStack toasts={toasts} dismiss={dismiss} />` near
 * the bottom of the page.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  message: string;
  /** Called when the user clicks Undo. If absent, no Undo button shows. */
  undo?: () => void | Promise<void>;
  /** Optional sub-message — usually the entity name being acted on. */
  detail?: string;
}

let nextId = 1;

export function useToasts(): {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
} {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((p) => p.filter((t) => t.id !== id));
    const handle = timersRef.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timersRef.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = nextId++;
      setToasts((p) => [...p, { id, ...t }]);
      const handle = setTimeout(() => dismiss(id), 4_000);
      timersRef.current.set(id, handle);
    },
    [dismiss],
  );

  // Cleanup on unmount.
  useEffect(() => {
    const map = timersRef.current;
    return () => {
      for (const h of map.values()) clearTimeout(h);
      map.clear();
    };
  }, []);

  return { toasts, push, dismiss };
}

export function ToastStack({
  toasts,
  dismiss,
}: {
  toasts: Toast[];
  dismiss: (id: number) => void;
}): React.ReactElement {
  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-start gap-3 px-4 py-3 rounded-lg shadow-lg border ${
            t.kind === "success"
              ? "bg-emerald-950/90 border-emerald-800 text-emerald-100"
              : t.kind === "error"
                ? "bg-red-950/90 border-red-800 text-red-100"
                : "bg-slate-900/95 border-slate-700 text-slate-100"
          }`}
        >
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">{t.message}</div>
            {t.detail && (
              <div className="text-xs opacity-70 mt-0.5 truncate">{t.detail}</div>
            )}
          </div>
          {t.undo && (
            <button
              type="button"
              className="text-xs font-semibold uppercase tracking-wide hover:underline px-2"
              onClick={async () => {
                try {
                  await t.undo!();
                } finally {
                  dismiss(t.id);
                }
              }}
            >
              Undo
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            className="text-sm opacity-60 hover:opacity-100"
            onClick={() => dismiss(t.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
