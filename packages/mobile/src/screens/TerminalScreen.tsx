import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "../theme";
import { getSessionArtifacts, type BrainSessionArtifactItem } from "../services/brainApi";
import { interveneSession } from "../services/api";
import { useWsEvent } from "../hooks/useWsEvent";

/**
 * Structured session transcript — the remote-control viewer.
 *
 * Fixes the old terminal screen's three sins:
 *  1. No more 2s full-blob polling that yanked you to the bottom. We
 *     backfill once from the brain's STRUCTURED artifacts, then append
 *     live WS events. Scroll position is preserved.
 *  2. Sticky-bottom ONLY when you're already at the bottom — scroll up to
 *     read and it won't fight you.
 *  3. Distinct rows per kind (user / assistant / command / output) instead
 *     of one undifferentiated dump.
 *
 * Works for CONNECTED (non-wrapped) sessions too — artifacts come from the
 * brain (hooks ingest them) and steering goes through redirect→queue→drain.
 */

type RowKind = "user" | "assistant" | "command" | "output" | "meta";

interface Row {
  id: string;
  kind: RowKind;
  text: string;
  ts: number;
}

function kindOf(artifactKind: string, actor: string | null): RowKind {
  if (artifactKind === "conversation/turn/user_message") return "user";
  if (artifactKind === "conversation/turn/assistant_message") return "assistant";
  if (artifactKind === "conversation/tool_call") return actor === "result" ? "output" : "command";
  if (artifactKind.startsWith("conversation/meta")) return "meta";
  return "output";
}

function toRow(a: BrainSessionArtifactItem): Row {
  return {
    id: a.hash,
    kind: kindOf(a.kind, a.actor),
    text: (a.snippet ?? "").trim(),
    ts: a.ts,
  };
}

const KIND_STYLE: Record<RowKind, { label: string; color: string; mono: boolean }> = {
  user: { label: "you", color: "#58a6ff", mono: false },
  assistant: { label: "claude", color: "#c9d1d9", mono: false },
  command: { label: "$", color: "#7ee787", mono: true },
  output: { label: "›", color: "#8b949e", mono: true },
  meta: { label: "·", color: "#6e7681", mono: true },
};

interface TerminalScreenProps {
  readonly route: { params: { sessionId: string; projectName: string; orgId?: string } };
}

export function TerminalScreen({ route }: TerminalScreenProps): React.JSX.Element {
  const { sessionId, projectName, orgId } = route.params;
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const listRef = useRef<FlatList<Row>>(null);
  const atBottomRef = useRef(true); // are we pinned to the bottom?
  const seen = useRef<Set<string>>(new Set());

  const append = useCallback((incoming: Row[]) => {
    if (incoming.length === 0) return;
    setRows((prev) => {
      const fresh = incoming.filter((r) => !seen.current.has(r.id));
      for (const r of fresh) seen.current.add(r.id);
      if (fresh.length === 0) return prev;
      return [...prev, ...fresh].sort((a, b) => a.ts - b.ts);
    });
  }, []);

  // Backfill once from structured artifacts (works for connected sessions).
  useEffect(() => {
    let cancelled = false;
    if (!orgId) {
      setErr("No org for this session — open it from the dashboard.");
      setLoading(false);
      return;
    }
    getSessionArtifacts(sessionId, orgId, { limit: 300, order: "asc" })
      .then((page) => {
        if (cancelled) return;
        const turns = page.items
          .filter((a) => a.kind.startsWith("conversation/"))
          .map(toRow)
          .filter((r) => r.text.length > 0);
        for (const r of turns) seen.current.add(r.id);
        setRows(turns);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, orgId]);

  // Live append from WS — a tool call or message lands, we add one row.
  // Stable handler so useWsEvent doesn't churn its subscription each render.
  const onWsOutput = useCallback((ev: unknown) => {
    const d = ev as { data?: { sessionId?: string; text?: string; line?: string } };
    const data = d?.data;
    if (!data || data.sessionId !== sessionId) return;
    const text = (data.text ?? data.line ?? "").trim();
    if (!text) return;
    append([{ id: `ws-${Date.now()}-${text.length}`, kind: "output", text, ts: Date.now() / 1000 }]);
  }, [sessionId, append]);
  useWsEvent("session:output", onWsOutput);

  // Auto-scroll to bottom ONLY if the user is already at the bottom.
  useEffect(() => {
    if (atBottomRef.current && rows.length > 0) {
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    }
  }, [rows]);

  const onScroll = useCallback((e: { nativeEvent: { layoutMeasurement: { height: number }; contentOffset: { y: number }; contentSize: { height: number } } }) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
    // "At bottom" with a 60px slack so small overscroll still counts.
    atBottomRef.current = layoutMeasurement.height + contentOffset.y >= contentSize.height - 60;
  }, []);

  const handleSend = useCallback(async () => {
    const msg = input.trim();
    if (!msg || sending) return;
    setSending(true);
    try {
      await interveneSession(sessionId, "redirect", msg);
      setInput("");
      // Optimistically show what we sent; it'll be confirmed when the
      // session picks it up (drain) and the brain re-ingests the turn.
      append([{ id: `sent-${Date.now()}`, kind: "user", text: msg, ts: Date.now() / 1000 }]);
      atBottomRef.current = true;
    } catch {
      setErr("Send failed — session may be offline.");
    } finally {
      setSending(false);
    }
  }, [input, sending, sessionId, append]);

  return (
    <SafeAreaView style={styles.container} edges={["bottom"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle} numberOfLines={1}>{projectName}</Text>
        <Text style={styles.headerMeta}>{rows.length} events</Text>
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={90}
      >
        {loading ? (
          <View style={styles.center}><ActivityIndicator color="#58a6ff" /><Text style={styles.dim}>Loading transcript…</Text></View>
        ) : err && rows.length === 0 ? (
          <View style={styles.center}><Text style={styles.errText}>{err}</Text></View>
        ) : (
          <FlatList
            ref={listRef}
            data={rows}
            keyExtractor={(r) => r.id}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            onScroll={onScroll}
            scrollEventThrottle={100}
            renderItem={({ item }) => {
              const s = KIND_STYLE[item.kind];
              return (
                <View style={styles.row}>
                  <Text style={[styles.rowLabel, { color: s.color }]}>{s.label}</Text>
                  <Text
                    style={[styles.rowText, s.mono && styles.mono, { color: item.kind === "assistant" ? "#c9d1d9" : s.color }]}
                    selectable
                  >
                    {item.text}
                  </Text>
                </View>
              );
            }}
          />
        )}

        <View style={styles.inputRow}>
          <TextInput
            style={styles.inputField}
            value={input}
            onChangeText={setInput}
            placeholder="Steer this session…"
            placeholderTextColor={colors.textMuted}
            returnKeyType="send"
            onSubmitEditing={handleSend}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
          />
          <Pressable style={[styles.sendButton, sending && styles.sendDisabled]} onPress={handleSend} disabled={sending}>
            <Text style={styles.sendButtonText}>{sending ? "…" : "Send"}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0d1117" },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  dim: { color: "#8b949e", fontSize: 13 },
  errText: { color: "#f85149", fontSize: 13, padding: 24, textAlign: "center" },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#21262d",
  },
  headerTitle: { fontSize: 16, fontWeight: "700", color: "#c9d1d9", flex: 1 },
  headerMeta: { fontSize: 11, color: "#6e7681", marginLeft: 8 },
  list: { flex: 1, backgroundColor: "#0d1117" },
  listContent: { padding: 12, paddingBottom: 24 },
  row: { flexDirection: "row", marginBottom: 10, gap: 8 },
  rowLabel: { fontSize: 11, fontWeight: "700", width: 48, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  rowText: { flex: 1, fontSize: 13, lineHeight: 18 },
  mono: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 11.5, lineHeight: 16 },
  inputRow: {
    flexDirection: "row", padding: 8, gap: 8, borderTopWidth: 1,
    borderTopColor: "#21262d", backgroundColor: "#161b22", alignItems: "flex-end",
  },
  inputField: {
    flex: 1, maxHeight: 120, backgroundColor: "#0d1117", borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, color: "#c9d1d9",
    borderWidth: 1, borderColor: "#30363d",
  },
  sendButton: { backgroundColor: colors.primary, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10, justifyContent: "center" },
  sendDisabled: { opacity: 0.5 },
  sendButtonText: { color: "#fff", fontWeight: "700", fontSize: 14 },
});
