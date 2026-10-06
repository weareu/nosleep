import { describe, it, expect, vi } from "vitest";

// voice.ts reports recorder failures to the server log; keep that observable.
const report = vi.fn();
vi.mock("../services/clientLog", () => ({ report: (...args: unknown[]) => report(...args) }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import { createAudioRecorder } from "../services/voice";

// expo-audio's real shape: the recorder class lives on `AudioModule`, NOT as
// a top-level export, and the native constructor wants the preset already
// flattened for the current platform. voice.ts used `new mod.AudioRecorder()`
// (undefined) inside a silent try/catch, so no voice note EVER produced an
// audio artifact.
const HIGH_QUALITY = {
  extension: ".m4a",
  sampleRate: 44100,
  numberOfChannels: 2,
  bitRate: 128000,
  android: { outputFormat: "mpeg4", audioEncoder: "aac" },
  ios: { outputFormat: "aac ", audioQuality: 127 },
  web: { mimeType: "audio/webm" },
};

function fakeExpoAudio() {
  const ctor = vi.fn(function (this: Record<string, unknown>, opts: unknown) {
    this.opts = opts;
    this.uri = null;
  });
  return {
    ctor,
    mod: {
      AudioModule: { AudioRecorder: ctor },
      RecordingPresets: { HIGH_QUALITY, LOW_QUALITY: HIGH_QUALITY },
      requestRecordingPermissionsAsync: async () => ({ granted: true }),
      setAudioModeAsync: async () => {},
    },
  };
}

describe("createAudioRecorder", () => {
  it("constructs AudioModule.AudioRecorder with iOS-flattened preset options", () => {
    const { ctor, mod } = fakeExpoAudio();
    const rec = createAudioRecorder(mod as never, "ios");
    expect(rec).not.toBeNull();
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(ctor.mock.calls[0][0]).toEqual({
      extension: ".m4a",
      sampleRate: 44100,
      numberOfChannels: 2,
      bitRate: 128000,
      isMeteringEnabled: false,
      outputFormat: "aac ",
      audioQuality: 127,
    });
  });

  it("flattens the android block on Android", () => {
    const { ctor, mod } = fakeExpoAudio();
    createAudioRecorder(mod as never, "android");
    expect(ctor.mock.calls[0][0]).toMatchObject({ outputFormat: "mpeg4", audioEncoder: "aac", extension: ".m4a" });
  });

  it("returns null and REPORTS when the module has no recorder class", () => {
    report.mockReset();
    const { mod } = fakeExpoAudio();
    const broken = { ...mod, AudioModule: {} };
    expect(createAudioRecorder(broken as never, "ios")).toBeNull();
    expect(report).toHaveBeenCalledWith("error", "voice.recorder", expect.stringMatching(/AudioRecorder/), expect.anything());
  });
});
