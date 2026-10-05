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
interface AudioModuleShape {
  AudioRecorder: new (options: unknown) => AudioRecorderInstance;
  RecordingPresets: { HIGH_QUALITY: unknown; LOW_QUALITY: unknown };
  requestRecordingPermissionsAsync(): Promise<{ granted: boolean }>;
  setAudioModeAsync(mode: {
    allowsRecording?: boolean;
    playsInSilentMode?: boolean;
  }): Promise<void>;
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
        recorder = new audioMod.AudioRecorder(audioMod.RecordingPresets.HIGH_QUALITY);
        await recorder.prepareToRecordAsync();
        recorder.record();
        recordStartedAt = Date.now();
      }
    } catch {
      // Continue without audio artifact — STT still works.
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
