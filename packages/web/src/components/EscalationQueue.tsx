import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchEscalations, respondToEscalation, type EscalationEvent } from "../lib/api";
import { useWebSocket } from "../hooks/useWebSocket";
import { Markdown } from "./Markdown";

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function EscalationCard({ escalation, onRespond }: {
  escalation: EscalationEvent;
  onRespond: (sessionId: string, message: string, escalationId: string) => Promise<void>;
}): React.ReactElement {
  const [response, setResponse] = useState("");
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (!response.trim() || sending) return;
    setSending(true);
    try {
      await onRespond(
        escalation.sessionId,
        response.trim(),
        escalation.payload.escalationId,
      );
      setResponse("");
    } finally {
      setSending(false);
    }
  };

  const handleSkip = async () => {
    if (sending) return;
    setSending(true);
    try {
      await onRespond(
        escalation.sessionId,
        "Continue autonomously. Make your best judgment.",
        escalation.payload.escalationId,
      );
    } finally {
      setSending(false);
    }
  };

  const confidencePct = Math.round(escalation.payload.confidence * 100);

  return (
    <div className="bg-slate-800 rounded-xl border border-yellow-600/30 p-4 min-w-0 overflow-hidden">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
          <span className="text-xs text-yellow-400 font-medium">AWAITING INPUT</span>
        </div>
        <span className="text-[10px] text-slate-500">{timeAgo(escalation.createdAt)}</span>
      </div>

      <div className="text-slate-200 mb-2 max-h-64 overflow-y-auto">
        <Markdown>{escalation.payload.question}</Markdown>
      </div>

      {/* flex-wrap + min-w-0/truncate: the reason can be a long regex and
          the menubar popover is ~340px — without these the chips bled over
          the input and pushed Send/Skip past the card edge. */}
      <div className="flex flex-wrap items-center gap-2 mb-3 min-w-0">
        <span
          className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400 max-w-full truncate"
          title={escalation.payload.reason}
        >
          {escalation.payload.reason}
        </span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400 whitespace-nowrap">
          {confidencePct}% confidence
        </span>
        <span className="text-[10px] text-slate-600 font-mono">
          {escalation.sessionId.slice(0, 8)}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          value={response}
          onChange={(e) => setResponse(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          placeholder="Type your response..."
          aria-label="Escalation response"
          className="flex-1 min-w-[140px] bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-yellow-500/50"
        />
        <button
          onClick={handleSend}
          disabled={sending || !response.trim()}
          className="shrink-0 px-3 py-1.5 bg-yellow-600/20 hover:bg-yellow-600/30 text-yellow-400 text-sm font-medium rounded-lg border border-yellow-600/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {sending ? "..." : "Send"}
        </button>
        <button
          onClick={handleSkip}
          disabled={sending}
          className="shrink-0 px-3 py-1.5 bg-slate-700/50 hover:bg-slate-700 text-slate-400 text-sm rounded-lg border border-slate-600/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="Auto-continue this question"
        >
          Skip
        </button>
      </div>
    </div>
  );
}

export function EscalationQueue(): React.ReactElement {
  const queryClient = useQueryClient();
  const lastProcessedRef = useRef<string | null>(null);

  const { data: escalations, isLoading } = useQuery<EscalationEvent[]>({
    queryKey: ["escalations"],
    queryFn: fetchEscalations,
    refetchInterval: 10_000,
  });

  // Auto-refresh on supervision events (in useEffect to avoid render side effects)
  const { lastEvent } = useWebSocket(["supervision:action"]);
  useEffect(() => {
    if (!lastEvent || lastEvent.timestamp === lastProcessedRef.current) return;
    const action = (lastEvent.data as { action?: string })?.action;
    if (action === "escalation" || action === "human-response") {
      lastProcessedRef.current = lastEvent.timestamp;
      queryClient.invalidateQueries({ queryKey: ["escalations"] });
    }
  }, [lastEvent, queryClient]);

  const handleRespond = async (sessionId: string, message: string, escalationId: string) => {
    await respondToEscalation(sessionId, message, escalationId);
    queryClient.invalidateQueries({ queryKey: ["escalations"] });
  };

  if (isLoading) {
    return <div className="text-slate-500 text-sm py-2">Loading...</div>;
  }

  if (!escalations || escalations.length === 0) {
    return (
      <div className="text-center py-6">
        <p className="text-slate-600 text-sm">No pending escalations</p>
        <p className="text-slate-700 text-xs mt-1">Sessions are running autonomously</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-yellow-400 uppercase tracking-wider flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
          Escalation Queue ({escalations.length})
        </h3>
      </div>
      {escalations.map((esc) => (
        <EscalationCard
          key={esc.id}
          escalation={esc}
          onRespond={handleRespond}
        />
      ))}
    </div>
  );
}
