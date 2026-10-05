/**
 * Mobile Capture tab — Phase 2 minimum: text-only thought capture with
 * project pill. Offline queue, voice, photo attach land in Phase 5/9.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  captureThought,
  ingestImage,
  ingestAudio,
  listThoughts,
  type BrainThought,
  type CaptureThoughtRequest,
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
import { colors } from "../theme";
import { OrgProjectPicker } from "../components/OrgProjectPicker";
import { StrategyParentPicker } from "../components/StrategyParentPicker";

const DRAFT_QUEUE_KEY = "@nosleep/brain-capture/queue/v1";

// expo-image-picker is loaded lazily so the app builds without it. Install
// via `npx expo install expo-image-picker` to enable photo attach.
type ImagePickerModule = {
  requestMediaLibraryPermissionsAsync(): Promise<{ granted: boolean }>;
  launchImageLibraryAsync(opts: {
    mediaTypes?: string;
    quality?: number;
    base64?: boolean;
    allowsEditing?: boolean;
  }): Promise<{
    canceled: boolean;
    assets?: Array<{
      base64?: string;
      uri: string;
      width: number;
      height: number;
      mimeType?: string;
    }>;
  }>;
  MediaTypeOptions?: { Images: string };
};

let imagePicker: ImagePickerModule | null | undefined;
function getImagePicker(): ImagePickerModule | null {
  if (imagePicker !== undefined) return imagePicker;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    imagePicker = require("expo-image-picker") as ImagePickerModule;
  } catch {
    imagePicker = null;
  }
  return imagePicker;
}

// Voice capture lives in services/voice.ts (expo-speech-recognition,
// lazy-loaded). The screen just drives start/stop and feeds the
// transcript into the input box below.

const THOUGHT_TYPES = [
  "observation",
  "task",
  "idea",
  "reference",
  "person_note",
  "decision",
  "insight",
  "question",
] as const;

// Phase 2 default — user sets project via server UI; Phase 9 adds in-app picker.
const DEFAULT_ORG = "org_personal";
const DEFAULT_PROJECT = "_org_level";

export function BrainCaptureScreen(): React.JSX.Element {
  const [content, setContent] = useState("");
  const [typeHint, setTypeHint] = useState<string>("");
  const [orgId, setOrgId] = useState(DEFAULT_ORG);
  const [projectId, setProjectId] = useState(DEFAULT_PROJECT);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [recent, setRecent] = useState<BrainThought[]>([]);
  const [attachedImage, setAttachedImage] = useState<{
    hash: string;
    uri: string;
  } | null>(null);
  const [pickingPhoto, setPickingPhoto] = useState(false);
  const [recording, setRecording] = useState(false);
  const [pendingAudio, setPendingAudio] =
    useState<VoiceRecordingResult | null>(null);
  const voiceSessionRef = useRef<VoiceSession | null>(null);
  // Where a successful Capture lands — brain (default) or a new strategy
  // child node under the project's current actionable parent.
  const [destination, setDestination] = useState<"brain" | "strategy">("brain");
  // Strategy parent override. `undefined` means "auto-pick next actionable";
  // `null` means "attach at root (no parent)"; otherwise a node id.
  const [strategyParent, setStrategyParent] = useState<
    string | null | undefined
  >(undefined);
  const [strategyParentTitle, setStrategyParentTitle] = useState<string | null>(
    null,
  );
  const [parentPickerOpen, setParentPickerOpen] = useState(false);

  async function onMicToggle() {
    if (recording) {
      const result = (await voiceSessionRef.current?.stop()) ?? null;
      voiceSessionRef.current = null;
      setRecording(false);
      if (result) setPendingAudio(result);
      return;
    }
    if (!isVoiceAvailable()) {
      setToast("Voice recogniser unavailable on this device");
      setTimeout(() => setToast(null), 3_000);
      return;
    }
    // Snapshot the current text so dictation appends instead of replacing
    // anything the user already typed. iOS Speech returns the full
    // cumulative transcript per session, so we just append it to prefix.
    const prefix = content.trim().length > 0 ? content.trim() + " " : "";
    // A fresh recording supersedes any earlier unsent audio.
    setPendingAudio(null);
    const session = await startVoiceCapture({
      recordAudio: true,
      onTranscript: (text) => {
        setContent(prefix + text);
      },
      onError: (msg) => {
        setToast("Voice error: " + msg);
        setTimeout(() => setToast(null), 3_000);
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

  // Always stop dictation when the user navigates away or the screen
  // unmounts, so the mic doesn't keep streaming after a tab switch.
  useEffect(() => {
    return () => {
      voiceSessionRef.current?.stop();
      voiceSessionRef.current = null;
    };
  }, []);

  async function loadRecent() {
    try {
      const r = await listThoughts({ org_id: orgId, project_id: projectId, limit: 10 });
      setRecent(r.items);
    } catch {
      // non-fatal
    }
  }

  useEffect(() => {
    loadRecent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, projectId]);

  async function onSubmitToStrategy(): Promise<void> {
    // Strategy notes need a real project, not the _org_level catch-all
    // — strategy nodes don't make sense outside a concrete project tree.
    if (projectId === "_org_level" || !projectId) {
      setToast("Pick a real project before sending to Strategy");
      setTimeout(() => setToast(null), 3_000);
      return;
    }
    setSubmitting(true);
    setToast(null);
    const text = content.trim();
    const title = text.length <= 60 ? text : text.slice(0, 57) + "…";
    try {
      // Three cases:
      //   strategyParent === undefined → auto-pick next-actionable (default)
      //   strategyParent === null      → explicit root, no parent
      //   strategyParent === <id>      → user picked a specific parent
      let parentId: string | null = null;
      if (strategyParent === undefined) {
        try {
          const next = await getNextActionable(projectId);
          const nextNode = (next as { data?: { id?: string } } | null)?.data;
          if (nextNode?.id) parentId = nextNode.id;
        } catch {
          /* fall back to root */
        }
      } else {
        parentId = strategyParent;
      }
      await createStrategyNode({
        projectId,
        orgId,
        parentId,
        type: "subtask",
        title,
        description: text,
      });
      setContent("");
      setTypeHint("");
      setAttachedImage(null);
      setToast(
        parentId
          ? "Sent to Strategy (child of current task)"
          : "Sent to Strategy (root)",
      );
      setTimeout(() => setToast(null), 3_000);
    } catch (e) {
      setToast(
        "Strategy send failed: " +
          (e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmit() {
    if (!content.trim() && !attachedImage) return;
    if (destination === "strategy") {
      // Photo + strategy combo isn't meaningful — strategy nodes are
      // text-only. Drop the attachment with a warning instead of silently
      // losing it.
      if (attachedImage) {
        setToast("Photos can only attach to Brain captures, not Strategy");
        setTimeout(() => setToast(null), 3_000);
        return;
      }
      await onSubmitToStrategy();
      return;
    }
    setSubmitting(true);
    setToast(null);

    // If a voice recording is pending, upload it first and attach it
    // as a source_ref on the captured thought. Failure to upload audio
    // shouldn't block the thought capture — the transcript is still
    // useful on its own. We just drop the artifact link in that case.
    const refs: Array<{ hash: string; relation: string }> = [];
    if (attachedImage) {
      refs.push({ hash: attachedImage.hash, relation: "references" });
    }
    if (pendingAudio) {
      const b64 = await readAudioAsBase64(pendingAudio.uri);
      if (b64) {
        try {
          const audioArtifact = await ingestAudio({
            base64: b64,
            content_type: pendingAudio.contentType,
            org_id: orgId,
            project_id: projectId,
            duration_ms: pendingAudio.durationMs,
            transcript: content.trim() || undefined,
          });
          refs.push({ hash: audioArtifact.hash, relation: "recorded_as" });
        } catch {
          /* audio upload non-fatal; still capture the thought */
        }
      }
    }

    const req: CaptureThoughtRequest = {
      content: content.trim() || (attachedImage ? "(photo)" : ""),
      org_id: orgId,
      project_id: projectId,
      source_kind: "mobile_note",
      thought_type_hint: typeHint || undefined,
      source_refs: refs.length > 0 ? refs : undefined,
    };
    try {
      const res = await captureThought(req);
      setContent("");
      setTypeHint("");
      setAttachedImage(null);
      setPendingAudio(null);
      setToast(
        res.similar_existing.length > 0
          ? `Captured — ${res.similar_existing.length} similar thought(s) exist`
          : "Captured",
      );
      await loadRecent();
      setTimeout(() => setToast(null), 3_000);
    } catch (e) {
      // Phase 12 (UI review M4) — never lose a capture. Persist the
      // request to AsyncStorage and retry on reconnect / app foreground.
      try {
        const raw = await AsyncStorage.getItem(DRAFT_QUEUE_KEY);
        const queue: CaptureThoughtRequest[] = raw ? JSON.parse(raw) : [];
        queue.push(req);
        await AsyncStorage.setItem(DRAFT_QUEUE_KEY, JSON.stringify(queue));
        setQueuedCount(queue.length);
        setToast(
          `Offline — queued (${queue.length} pending). Will retry when reachable.`,
        );
        // Clear the form so the user can start the next thought.
        setContent("");
        setTypeHint("");
        setAttachedImage(null);
      } catch {
        setToast(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      setSubmitting(false);
    }
  }

  // Phase 12 (UI review M4) — queued offline drafts.
  const [queuedCount, setQueuedCount] = useState(0);

  const flushQueue = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(DRAFT_QUEUE_KEY);
      if (!raw) return;
      const queue: CaptureThoughtRequest[] = JSON.parse(raw);
      if (queue.length === 0) return;
      const remaining: CaptureThoughtRequest[] = [];
      let flushed = 0;
      for (const item of queue) {
        try {
          await captureThought(item);
          flushed += 1;
        } catch {
          remaining.push(item);
        }
      }
      await AsyncStorage.setItem(DRAFT_QUEUE_KEY, JSON.stringify(remaining));
      setQueuedCount(remaining.length);
      if (flushed > 0) {
        setToast(
          remaining.length === 0
            ? `Synced ${flushed} queued capture${flushed === 1 ? "" : "s"}`
            : `Synced ${flushed}, ${remaining.length} still queued`,
        );
        setTimeout(() => setToast(null), 4_000);
        await loadRecent();
      }
    } catch {
      /* non-fatal */
    }
  }, []);

  // Initial queue count + foreground retry.
  useEffect(() => {
    AsyncStorage.getItem(DRAFT_QUEUE_KEY)
      .then((raw) => {
        const queue: CaptureThoughtRequest[] = raw ? JSON.parse(raw) : [];
        setQueuedCount(queue.length);
        if (queue.length > 0) flushQueue();
      })
      .catch(() => {});
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") flushQueue();
    });
    return () => sub.remove();
  }, [flushQueue]);

  async function onAttachPhoto() {
    const picker = getImagePicker();
    if (!picker) {
      setToast("Run `npx expo install expo-image-picker` to enable photo attach");
      setTimeout(() => setToast(null), 4_000);
      return;
    }
    try {
      setPickingPhoto(true);
      const perm = await picker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setToast("Photo library permission denied");
        return;
      }
      const result = await picker.launchImageLibraryAsync({
        mediaTypes: picker.MediaTypeOptions?.Images ?? "Images",
        quality: 0.7,
        base64: true,
        allowsEditing: false,
      });
      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }
      const asset = result.assets[0];
      if (!asset.base64) {
        setToast("Failed to read image data");
        return;
      }
      const ingest = await ingestImage({
        base64: asset.base64,
        content_type: asset.mimeType ?? "image/jpeg",
        org_id: orgId,
        project_id: projectId,
        width: asset.width,
        height: asset.height,
      });
      setAttachedImage({ hash: ingest.hash, uri: asset.uri });
      setToast(`Photo attached (${ingest.duplicate ? "dup" : "new"})`);
      setTimeout(() => setToast(null), 2_500);
    } catch (e) {
      setToast(`Photo error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPickingPhoto(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.topRow}>
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
          placeholder="What's worth remembering?"
          placeholderTextColor={colors.textMuted}
          multiline
          autoCapitalize="sentences"
          textAlignVertical="top"
        />

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.typeRow}>
          <TouchableOpacity
            style={[styles.typeChip, typeHint === "" && styles.typeChipActive]}
            onPress={() => setTypeHint("")}
          >
            <Text style={[styles.typeChipText, typeHint === "" && styles.typeChipTextActive]}>
              auto
            </Text>
          </TouchableOpacity>
          {THOUGHT_TYPES.map((t) => (
            <TouchableOpacity
              key={t}
              style={[styles.typeChip, typeHint === t && styles.typeChipActive]}
              onPress={() => setTypeHint(t)}
            >
              <Text style={[styles.typeChipText, typeHint === t && styles.typeChipTextActive]}>
                {t}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <View style={styles.attachRow}>
          <TouchableOpacity
            style={[styles.attachBtn, pickingPhoto && styles.submitDisabled]}
            onPress={onAttachPhoto}
            disabled={pickingPhoto}
          >
            <Text style={styles.attachText}>
              {attachedImage ? "📷 photo attached" : pickingPhoto ? "Picking…" : "📷 Attach photo"}
            </Text>
          </TouchableOpacity>
          {attachedImage && (
            <TouchableOpacity onPress={() => setAttachedImage(null)}>
              <Text style={styles.attachRemove}>✕ remove</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[
              styles.attachBtn,
              recording && { backgroundColor: "#ef4444", borderColor: "#ef4444" },
            ]}
            onPress={onMicToggle}
          >
            <Text
              style={[
                styles.attachText,
                recording && { color: "#fff" },
              ]}
            >
              {recording ? "⏺ Stop" : "🎤 Voice"}
            </Text>
          </TouchableOpacity>
          {pendingAudio && !recording && (
            <TouchableOpacity
              style={styles.audioPill}
              onPress={() => setPendingAudio(null)}
            >
              <Text style={styles.audioPillText}>
                🎤 {(pendingAudio.durationMs / 1000).toFixed(1)}s · ✕
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

        {destination === "strategy" && (
          <TouchableOpacity
            style={styles.parentRow}
            onPress={() => {
              if (projectId === "_org_level" || !projectId) {
                setToast("Pick a real project first");
                setTimeout(() => setToast(null), 2_500);
                return;
              }
              setParentPickerOpen(true);
            }}
          >
            <Text style={styles.parentLabel}>Parent:</Text>
            <Text style={styles.parentValue} numberOfLines={1}>
              {strategyParent === undefined
                ? "auto (next actionable)"
                : strategyParent === null
                  ? "(root — no parent)"
                  : strategyParentTitle ?? "selected node"}
            </Text>
            <Text style={styles.parentChange}>change</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={[
            styles.submit,
            (!content.trim() && !attachedImage) || submitting
              ? styles.submitDisabled
              : null,
          ]}
          onPress={onSubmit}
          disabled={(!content.trim() && !attachedImage) || submitting}
        >
          <Text style={styles.submitText}>
            {submitting
              ? destination === "strategy"
                ? "Sending…"
                : "Capturing…"
              : destination === "strategy"
                ? "Send to Strategy"
                : "Capture"}
          </Text>
        </TouchableOpacity>

        {toast && (
          <Text
            style={styles.toast}
            // Phase 12 (UI review L3) — let screen readers announce toast
            // updates without yanking focus.
            accessibilityLiveRegion="polite"
          >
            {toast}
          </Text>
        )}

        {queuedCount > 0 && (
          <View style={styles.queuedChip}>
            <Text style={styles.queuedChipText}>
              {queuedCount} capture{queuedCount === 1 ? "" : "s"} pending — will retry
            </Text>
            <TouchableOpacity onPress={flushQueue}>
              <Text style={styles.queuedChipAction}>retry now</Text>
            </TouchableOpacity>
          </View>
        )}

        {parentPickerOpen && (
          <StrategyParentPicker
            visible={parentPickerOpen}
            projectId={projectId}
            selectedId={strategyParent === undefined ? null : strategyParent}
            onCancel={() => setParentPickerOpen(false)}
            onSelect={(id, title) => {
              setStrategyParent(id);
              setStrategyParentTitle(title);
              setParentPickerOpen(false);
            }}
          />
        )}

        {recent.length > 0 && (
          <View style={styles.recentBlock}>
            <Text style={styles.recentHeader}>Recent in this project</Text>
            {recent.map((t) => (
              <View key={t.id} style={styles.recentItem}>
                <Text style={styles.recentMeta}>
                  {t.thought_type ?? "?"} · {new Date(t.created_at * 1000).toLocaleString()}
                </Text>
                <Text style={styles.recentContent} numberOfLines={3}>
                  {t.content}
                </Text>
                {t.metadata.topics.length > 0 && (
                  <View style={styles.recentTags}>
                    {t.metadata.topics.map((tp) => (
                      <Text key={tp} style={styles.tag}>
                        {tp}
                      </Text>
                    ))}
                  </View>
                )}
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    padding: 16,
    paddingBottom: 48,
  },
  topRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 12,
  },
  pill: {
    flex: 1,
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  pillLabel: {
    fontSize: 10,
    textTransform: "uppercase",
    color: colors.textMuted,
    letterSpacing: 1,
  },
  pillInput: {
    color: colors.textPrimary,
    fontSize: 13,
    padding: 0,
  },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    fontSize: 16,
    color: colors.textPrimary,
    minHeight: 180,
    marginBottom: 12,
  },
  typeRow: {
    flexDirection: "row",
    marginBottom: 14,
  },
  typeChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    marginRight: 8,
  },
  typeChipActive: {
    backgroundColor: "#3b82f6",
    borderColor: "#3b82f6",
  },
  typeChipText: {
    color: colors.textMuted,
    fontSize: 12,
  },
  typeChipTextActive: {
    color: "#fff",
    fontWeight: "600",
  },
  submit: {
    backgroundColor: "#3b82f6",
    padding: 14,
    borderRadius: 10,
    alignItems: "center",
  },
  submitDisabled: {
    opacity: 0.5,
  },
  attachRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 12,
  },
  attachBtn: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },
  attachText: {
    color: colors.textPrimary,
    fontSize: 13,
  },
  attachRemove: {
    color: "#f87171",
    fontSize: 12,
  },
  audioPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(59, 130, 246, 0.15)",
    borderWidth: 1,
    borderColor: "rgba(59, 130, 246, 0.5)",
  },
  audioPillText: {
    color: "#93c5fd",
    fontSize: 11,
    fontWeight: "600",
  },
  destRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 10,
  },
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
  destText: {
    color: colors.textMuted,
    fontSize: 13,
  },
  destTextActive: {
    color: "#93c5fd",
    fontWeight: "600",
  },
  parentRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
    gap: 8,
  },
  parentLabel: {
    color: colors.textMuted,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  parentValue: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 13,
  },
  parentChange: {
    color: "#3b82f6",
    fontSize: 12,
    fontWeight: "600",
  },
  submitText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  toast: {
    marginTop: 12,
    padding: 10,
    backgroundColor: colors.card,
    color: colors.textPrimary,
    borderRadius: 8,
    textAlign: "center",
    fontSize: 13,
  },
  queuedChip: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "rgba(245, 158, 11, 0.12)",
    borderColor: "rgba(245, 158, 11, 0.35)",
    borderWidth: 1,
    borderRadius: 8,
  },
  queuedChipText: {
    color: "#fbbf24",
    fontSize: 12,
    flex: 1,
  },
  queuedChipAction: {
    color: "#fbbf24",
    fontSize: 12,
    fontWeight: "700",
    textDecorationLine: "underline",
    marginLeft: 12,
  },
  recentBlock: {
    marginTop: 24,
  },
  recentHeader: {
    color: colors.textMuted,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 8,
  },
  recentItem: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  recentMeta: {
    color: colors.textMuted,
    fontSize: 10,
    marginBottom: 4,
  },
  recentContent: {
    color: colors.textPrimary,
    fontSize: 13,
    lineHeight: 18,
  },
  recentTags: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 6,
  },
  tag: {
    backgroundColor: "rgba(59, 130, 246, 0.2)",
    color: "#93c5fd",
    fontSize: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginRight: 4,
    marginTop: 2,
  },
});
