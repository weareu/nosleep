/**
 * Global floating mic button — visible on every screen via absolute
 * positioning above the navigator. Tap to open a compact sheet that
 * lets you dictate a quick voice note and fire it at either the brain
 * archive or the strategy tree without leaving the current screen.
 *
 * Project / org context: persists the last-used org and project so a
 * second tap goes to the same place. First-ever use defaults to
 * `org_personal` + `_org_level` (the org-wide catch-all bucket for
 * brain; strategy is disabled until a real project is picked).
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  captureThought,
  ingestAudio,
} from "../services/brainApi";
import {
  createStrategyNode,
  getNextActionable,
} from "../services/api";
import {
  startVoiceCapture,
  isVoiceAvailable,
  readAudioAsBase64,
  type VoiceSession,
  type VoiceRecordingResult,
} from "../services/voice";
import { colors, TAB_BAR_HEIGHT } from "../theme";
import { OrgProjectPicker } from "./OrgProjectPicker";

const LAST_SCOPE_KEY = "@nosleep/mic-fab/last-scope/v1";

const FAB_SIZE = 56;
/** Gap between the tab bar and the FAB. */
const FAB_GAP = 14;

/**
 * Bottom padding a tab screen's scroll content needs so its last rows can
 * scroll clear of the floating mic button (FAB height + gaps above the tab
 * bar). Apply to `contentContainerStyle.paddingBottom` of tab-screen lists.
 */
export const FAB_CONTENT_INSET = FAB_GAP + FAB_SIZE + 12;

interface PersistedScope {
  orgId: string;
  projectId: string;
}

export function GlobalMicFab(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  // Sit just above the tab bar on every device (home-indicator iPhones,
  // web, Android) instead of a hard-coded offset.
  const insets = useSafeAreaInsets();
  const bottom = insets.bottom + TAB_BAR_HEIGHT + FAB_GAP;

  return (
    <>
      <Pressable
        // Long-press opens straight to recording for hands-free use.
        onPress={() => setOpen(true)}
        onLongPress={() => setOpen(true)}
        style={({ pressed }) => [styles.fab, { bottom }, pressed && styles.fabPressed]}
        accessibilityLabel="Quick voice note"
        accessibilityRole="button"
      >
        <Text style={styles.fabIcon}>🎤</Text>
      </Pressable>
      <Modal
        visible={open}
        animationType="slide"
        transparent
        onRequestClose={() => setOpen(false)}
      >
        <MicSheet onClose={() => setOpen(false)} />
      </Modal>
    </>
  );
}

interface MicSheetProps {
  onClose(): void;
}

function MicSheet({ onClose }: MicSheetProps): React.JSX.Element {
  const [orgId, setOrgId] = useState("org_personal");
  const [projectId, setProjectId] = useState("_org_level");
  const [destination, setDestination] = useState<"brain" | "strategy">("brain");
  const [content, setContent] = useState("");
  const [recording, setRecording] = useState(false);
  const [pendingAudio, setPendingAudio] =
    useState<VoiceRecordingResult | null>(null);
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const voiceSessionRef = useRef<VoiceSession | null>(null);

  useEffect(() => {
    // Restore last-used scope so a second tap goes to the same target.
    AsyncStorage.getItem(LAST_SCOPE_KEY)
      .then((raw) => {
        if (!raw) return;
        try {
          const s = JSON.parse(raw) as PersistedScope;
          if (s.orgId) setOrgId(s.orgId);
          if (s.projectId) setProjectId(s.projectId);
        } catch {
          /* ignore */
        }
      })
      .catch(() => {});
  }, []);

  // Persist scope changes so the next session opens here.
  useEffect(() => {
    AsyncStorage.setItem(
      LAST_SCOPE_KEY,
      JSON.stringify({ orgId, projectId }),
    ).catch(() => {});
  }, [orgId, projectId]);

  // Always stop dictation when the sheet unmounts so the mic doesn't
  // keep streaming.
  useEffect(() => {
    return () => {
      voiceSessionRef.current?.stop();
      voiceSessionRef.current = null;
    };
  }, []);

  const showToast = useCallback((msg: string, ms = 2_500) => {
    setToast(msg);
    setTimeout(() => setToast(null), ms);
  }, []);

  async function toggleMic(): Promise<void> {
    if (recording) {
      const result = (await voiceSessionRef.current?.stop()) ?? null;
      voiceSessionRef.current = null;
      setRecording(false);
      if (result) setPendingAudio(result);
      return;
    }
    if (!isVoiceAvailable()) {
      showToast("Voice not available on this device");
      return;
    }
    const prefix = content.trim().length > 0 ? content.trim() + " " : "";
    setPendingAudio(null);
    const session = await startVoiceCapture({
      recordAudio: true,
      onTranscript: (text) => setContent(prefix + text),
      onError: (m) => {
        showToast("Voice error: " + m);
        setRecording(false);
        voiceSessionRef.current = null;
      },
      onEnd: () => {
        setRecording(false);
        voiceSessionRef.current = null;
      },
    });
    if (session) {
      voiceSessionRef.current = session;
      setRecording(true);
    }
  }

  async function send(): Promise<void> {
    const text = content.trim();
    if (!text) return;
    setSending(true);
    try {
      if (destination === "strategy") {
        if (projectId === "_org_level" || !projectId) {
          showToast("Pick a real project to send to Strategy");
          return;
        }
        let parentId: string | null = null;
        try {
          const next = await getNextActionable(projectId);
          parentId =
            (next as { data?: { id?: string } } | null)?.data?.id ?? null;
        } catch {
          /* fall back to root */
        }
        const title = text.length <= 60 ? text : text.slice(0, 57) + "…";
        await createStrategyNode({
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
        if (pendingAudio) {
          const b64 = await readAudioAsBase64(pendingAudio.uri);
          if (b64) {
            try {
              const art = await ingestAudio({
                base64: b64,
                content_type: pendingAudio.contentType,
                org_id: orgId,
                project_id: projectId,
                duration_ms: pendingAudio.durationMs,
                transcript: text,
              });
              refs.push({ hash: art.hash, relation: "recorded_as" });
            } catch {
              /* non-fatal */
            }
          }
        }
        await captureThought({
          content: text,
          org_id: orgId,
          project_id: projectId,
          source_kind: "mobile_note",
          source_refs: refs.length > 0 ? refs : undefined,
        });
        showToast("Captured to Brain");
      }
      setContent("");
      setPendingAudio(null);
      // Auto-close on success after a tiny delay so the user sees the toast.
      setTimeout(onClose, 600);
    } catch (e) {
      showToast(
        "Send failed: " + (e instanceof Error ? e.message : String(e)),
        4_000,
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <Pressable style={styles.backdrop} onPress={onClose}>
      <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
        <SafeAreaView edges={["bottom"]}>
          <View style={styles.handle} />
          <View style={styles.scopeRow}>
            <OrgProjectPicker
              scope={{ orgId, projectId }}
              onChange={(s) => {
                setOrgId(s.orgId);
                setProjectId(s.projectId);
              }}
            />
          </View>

          <TextInput
            style={styles.input}
            value={content}
            onChangeText={setContent}
            placeholder="Speak or type a quick note…"
            placeholderTextColor={colors.textMuted}
            multiline
            autoCapitalize="sentences"
            textAlignVertical="top"
          />

          <View style={styles.row}>
            <TouchableOpacity
              style={[
                styles.micBtn,
                recording && styles.micBtnRecording,
              ]}
              onPress={toggleMic}
            >
              <Text style={[styles.micText, recording && { color: "#fff" }]}>
                {recording ? "⏺ Stop" : "🎤 Record"}
              </Text>
            </TouchableOpacity>
            {pendingAudio && !recording && (
              <TouchableOpacity
                style={styles.audioPill}
                onPress={() => setPendingAudio(null)}
              >
                <Text style={styles.audioPillText}>
                  🎤 {(pendingAudio.durationMs / 1000).toFixed(1)}s ✕
                </Text>
              </TouchableOpacity>
            )}
          </View>

          <View style={styles.destRow}>
            <TouchableOpacity
              style={[
                styles.destBtn,
                destination === "brain" && styles.destBtnActive,
              ]}
              onPress={() => setDestination("brain")}
            >
              <Text
                style={[
                  styles.destText,
                  destination === "brain" && styles.destTextActive,
                ]}
              >
                🧠 Brain
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.destBtn,
                destination === "strategy" && styles.destBtnActive,
              ]}
              onPress={() => setDestination("strategy")}
            >
              <Text
                style={[
                  styles.destText,
                  destination === "strategy" && styles.destTextActive,
                ]}
              >
                🎯 Strategy
              </Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[
              styles.sendBtn,
              (!content.trim() || sending) && styles.sendBtnDisabled,
            ]}
            disabled={!content.trim() || sending}
            onPress={send}
          >
            <Text style={styles.sendText}>
              {sending ? "Sending…" : destination === "strategy" ? "Send to Strategy" : "Capture to Brain"}
            </Text>
          </TouchableOpacity>

          {toast && (
            <Text style={styles.toast} accessibilityLiveRegion="polite">
              {toast}
            </Text>
          )}
        </SafeAreaView>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    right: 18,
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_SIZE / 2,
    backgroundColor: "#3b82f6",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  fabPressed: { opacity: 0.85 },
  fabIcon: { fontSize: 24 },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 16,
    minHeight: 320,
  },
  handle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.cardBorder,
    marginBottom: 8,
  },
  scopeRow: { marginBottom: 10 },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    color: colors.textPrimary,
    minHeight: 100,
    marginBottom: 10,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
  },
  micBtn: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
  },
  micBtnRecording: { backgroundColor: "#ef4444", borderColor: "#ef4444" },
  micText: { color: colors.textPrimary, fontSize: 13, fontWeight: "600" },
  audioPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(59, 130, 246, 0.15)",
    borderColor: "rgba(59, 130, 246, 0.5)",
    borderWidth: 1,
  },
  audioPillText: { color: "#93c5fd", fontSize: 11, fontWeight: "600" },
  destRow: { flexDirection: "row", gap: 8, marginBottom: 10 },
  destBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.card,
    alignItems: "center",
  },
  destBtnActive: {
    backgroundColor: "rgba(59, 130, 246, 0.15)",
    borderColor: "#3b82f6",
  },
  destText: { color: colors.textMuted, fontSize: 13 },
  destTextActive: { color: "#93c5fd", fontWeight: "600" },
  sendBtn: {
    backgroundColor: "#3b82f6",
    padding: 14,
    borderRadius: 10,
    alignItems: "center",
  },
  sendBtnDisabled: { opacity: 0.5 },
  sendText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  toast: {
    marginTop: 10,
    padding: 10,
    backgroundColor: colors.card,
    color: colors.textPrimary,
    borderRadius: 8,
    textAlign: "center",
    fontSize: 13,
  },
});
