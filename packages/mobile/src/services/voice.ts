/**
 * Voice capture service — lazy-loaded wrapper around
 * `expo-speech-recognition` (on-device STT via Apple Speech / Android
 * SpeechRecognizer) and `expo-audio` (m4a recording). Same lazy-load
 * pattern as the image-picker so the app still builds if the native
 * modules aren't installed yet.
 *
 * A single call to `startVoiceCapture` runs both in parallel: live STT
 * for fast UX, plus an m4a recording you can later upload as an
 * audio artifact to replay the original audio.
 */

import { Platform } from "react-native";
import { report as clientLog } from "./clientLog";

interface SpeechResultEvent {
  results?: Array<{ transcript: string }>;
  isFinal?: boolean;
}

interface SpeechErrorEvent {
  error?: string;
  message?: string;
}

interface SubscriptionLike {
  remove(): void;
}

interface ExpoSpeechRecognitionModule {
  requestPermissionsAsync(): Promise<{ granted: boolean; status: string }>;
  getPermissionsAsync(): Promise<{ granted: boolean; status: string }>;
  isRecognitionAvailable(): boolean;
  start(opts: {
    lang?: string;
    interimResults?: boolean;
    continuous?: boolean;
    requiresOnDeviceRecognition?: boolean;
  }): void;
  stop(): void;
  abort?(): void;
}

interface SpeechModuleShape {
  ExpoSpeechRecognitionModule: ExpoSpeechRecognitionModule;
  addSpeechRecognitionListener: (
    event:
      | "result"
      | "end"
      | "error"
      | "start"
      | "speechstart"
      | "speechend"
      | "nomatch",
    cb: (e: SpeechResultEvent | SpeechErrorEvent | undefined) => void,
  ) => SubscriptionLike;
}

let cachedModule: SpeechModuleShape | null | undefined;
function getSpeechModule(): SpeechModuleShape | null {
  if (cachedModule !== undefined) return cachedModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedModule = require("expo-speech-recognition") as SpeechModuleShape;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

interface AudioRecorderInstance {
  uri: string | null;
  prepareToRecordAsync(): Promise<void>;
  record(): void;
  stop(): Promise<void>;
}
/** expo-audio RecordingOptions: common fields + one block per platform. */
interface RecordingPreset {
  extension: string;
  sampleRate: number;
  numberOfChannels: number;
  bitRate: number;
  isMeteringEnabled?: boolean;
  ios?: Record<string, unknown>;
  android?: Record<string, unknown>;
  web?: Record<string, unknown>;
}
interface AudioModuleShape {
  // The recorder class is on `AudioModule`, not a top-level export.
  AudioModule: { AudioRecorder?: new (options: unknown) => AudioRecorderInstance };
  RecordingPresets: { HIGH_QUALITY: RecordingPreset; LOW_QUALITY: RecordingPreset };
  requestRecordingPermissionsAsync(): Promise<{ granted: boolean }>;
  setAudioModeAsync(mode: {
    allowsRecording?: boolean;
    playsInSilentMode?: boolean;
  }): Promise<void>;
}

/**
 * Build an expo-audio recorder the way its `useAudioRecorder` hook does
 * (`new AudioModule.AudioRecorder(platformOptions)`) — usable outside a
 * component. The native constructor wants the preset flattened for the
 * current platform (expo-audio's own flattener isn't exported). Returns null
 * and reports to the server log on failure: this used to be
 * `new mod.AudioRecorder()` — undefined — inside a silent catch, so no voice
 * note ever produced an audio artifact.
 */
export function createAudioRecorder(
  audioMod: AudioModuleShape,
  os: string,
): AudioRecorderInstance | null {
  const Recorder = audioMod.AudioModule?.AudioRecorder;
  if (typeof Recorder !== "function") {
    clientLog("error", "voice.recorder", "expo-audio AudioModule.AudioRecorder is unavailable", { os });
    return null;
  }
  const preset = audioMod.RecordingPresets.HIGH_QUALITY;
  const platformBlock =
    os === "ios" ? preset.ios : os === "android" ? preset.android : preset.web;
  try {
    return new Recorder({
      extension: preset.extension,
      sampleRate: preset.sampleRate,
      numberOfChannels: preset.numberOfChannels,
      bitRate: preset.bitRate,
      isMeteringEnabled: preset.isMeteringEnabled ?? false,
      ...platformBlock,
    });
  } catch (err) {
    clientLog(
      "error",
      "voice.recorder",
      err instanceof Error ? err.message : String(err),
      { os },
      err instanceof Error ? err.stack : undefined,
    );
    return null;
  }
}

let cachedAudio: AudioModuleShape | null | undefined;
function getAudioModule(): AudioModuleShape | null {
  if (cachedAudio !== undefined) return cachedAudio;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedAudio = require("expo-audio") as AudioModuleShape;
  } catch {
    cachedAudio = null;
  }
  return cachedAudio;
}

interface LegacyFileSystemShape {
  readAsStringAsync(
    uri: string,
    opts: { encoding: "base64" | string },
  ): Promise<string>;
  EncodingType: { Base64: string };
  getInfoAsync(uri: string): Promise<{ exists: boolean; size?: number }>;
}
let cachedFs: LegacyFileSystemShape | null | undefined;
function getFileSystem(): LegacyFileSystemShape | null {
  if (cachedFs !== undefined) return cachedFs;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedFs = require("expo-file-system/legacy") as LegacyFileSystemShape;
  } catch {
    cachedFs = null;
  }
  return cachedFs;
}

export function isVoiceAvailable(): boolean {
  const mod = getSpeechModule();
  if (!mod) return false;
  try {
    return mod.ExpoSpeechRecognitionModule.isRecognitionAvailable();
  } catch {
    return false;
  }
}

export interface VoiceStartOptions {
  /** BCP-47, e.g. "en-US". Defaults to device locale. */
  lang?: string;
  /** Fires for every partial + final transcript. */
  onTranscript: (text: string, isFinal: boolean) => void;
  onError?: (message: string) => void;
  onEnd?: () => void;
  /**
   * If true (default), record m4a alongside STT so the caller can
   * upload it as an audio artifact afterwards. Set false for STT-only.
   */
  recordAudio?: boolean;
}

export interface VoiceRecordingResult {
  uri: string;
  durationMs: number;
  contentType: "audio/mp4";
}

export interface VoiceSession {
  /**
   * Stop dictation. If audio recording was on, resolves to the audio
   * file metadata once finalised; otherwise null. Either way, listeners
   * are removed exactly once.
   */
  stop(): Promise<VoiceRecordingResult | null>;
}

/**
 * Start a recording + transcription session. Returns a handle whose
 * `stop()` ends recognition and tears down listeners. Caller is
 * responsible for calling `stop()` exactly once.
 */
export async function startVoiceCapture(
  opts: VoiceStartOptions,
): Promise<VoiceSession | null> {
  const mod = getSpeechModule();
  if (!mod) {
    opts.onError?.("voice module not installed");
    return null;
  }

  const perm = await mod.ExpoSpeechRecognitionModule.requestPermissionsAsync();
  if (!perm.granted) {
    opts.onError?.("microphone or speech recognition permission denied");
    return null;
  }

  // Optionally spin up the audio recorder. STT alone covers the UX —
  // the m4a artifact is a "nice to have" for playback, so any failure
  // here is non-fatal: we keep the transcript flowing and skip audio.
  const audioMod = opts.recordAudio === false ? null : getAudioModule();
  let recorder: AudioRecorderInstance | null = null;
  let recordStartedAt: number | null = null;
  if (audioMod) {
    try {
      const audioPerm = await audioMod.requestRecordingPermissionsAsync();
      if (audioPerm.granted) {
        await audioMod.setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
        });
        recorder = createAudioRecorder(audioMod, Platform.OS);
        if (recorder) {
          await recorder.prepareToRecordAsync();
          recorder.record();
          recordStartedAt = Date.now();
        }
      }
    } catch (err) {
      // Continue without audio artifact — STT still works. Reported so a
      // broken recorder is visible in the server log, not silently lost.
      clientLog(
        "error",
        "voice.recorder",
        err instanceof Error ? err.message : String(err),
        undefined,
        err instanceof Error ? err.stack : undefined,
      );
      recorder = null;
      recordStartedAt = null;
    }
  }

  const subs: SubscriptionLike[] = [];
  let stopped = false;

  subs.push(
    mod.addSpeechRecognitionListener("result", (e) => {
      const ev = e as SpeechResultEvent | undefined;
      const text = ev?.results?.[0]?.transcript ?? "";
      if (text.length === 0) return;
      opts.onTranscript(text, ev?.isFinal === true);
    }),
  );
  subs.push(
    mod.addSpeechRecognitionListener("error", (e) => {
      const ev = e as SpeechErrorEvent | undefined;
      opts.onError?.(ev?.message ?? ev?.error ?? "unknown speech error");
    }),
  );
  subs.push(
    mod.addSpeechRecognitionListener("end", () => {
      opts.onEnd?.();
    }),
  );

  try {
    mod.ExpoSpeechRecognitionModule.start({
      lang: opts.lang,
      interimResults: true,
      continuous: true,
      // On-device when supported; falls back to network if not.
      requiresOnDeviceRecognition: false,
    });
  } catch (err) {
    for (const s of subs) s.remove();
    if (recorder) {
      // Best-effort tear-down of the recorder we just started.
      try { await recorder.stop(); } catch { /* ignore */ }
    }
    opts.onError?.(err instanceof Error ? err.message : String(err));
    return null;
  }

  return {
    async stop(): Promise<VoiceRecordingResult | null> {
      if (stopped) return null;
      stopped = true;
      try {
        mod.ExpoSpeechRecognitionModule.stop();
      } catch {
        /* ignore */
      }
      for (const s of subs) s.remove();
      if (recorder && recordStartedAt !== null) {
        try {
          await recorder.stop();
          const uri = recorder.uri;
          if (typeof uri === "string" && uri.length > 0) {
            return {
              uri,
              durationMs: Date.now() - recordStartedAt,
              contentType: "audio/mp4",
            };
          }
        } catch {
          /* tear-down errors are non-fatal */
        }
      }
      return null;
    },
  };
}

/**
 * Read a recorded audio file back as base64 so it can be uploaded to
 * the brain `/api/brain/ingest` endpoint. Returns null if expo-file-system
 * isn't installed or the file is missing.
 */
export async function readAudioAsBase64(uri: string): Promise<string | null> {
  const fs = getFileSystem();
  if (!fs) return null;
  try {
    const info = await fs.getInfoAsync(uri);
    if (!info.exists) return null;
    const b64 = await fs.readAsStringAsync(uri, {
      encoding: fs.EncodingType.Base64,
    });
    return b64;
  } catch {
    return null;
  }
}
