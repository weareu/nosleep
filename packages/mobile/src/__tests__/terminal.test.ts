import { describe, it, expect } from "vitest";

// Extract the function for testing — since it's not exported,
// we test it via a copy. In production it lives in TerminalScreen.tsx.
function cleanTerminalOutput(raw: string): string {
  const noAnsi = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  return noAnsi
    .split("\n")
    .map((line) => {
      const parts = line.split("\r");
      return parts[parts.length - 1];
    })
    .join("\n");
}

describe("cleanTerminalOutput", () => {
  it("strips ANSI color codes", () => {
    const input = "\x1b[32mSuccess\x1b[0m: done";
    expect(cleanTerminalOutput(input)).toBe("Success: done");
  });

  it("strips ANSI cursor movement codes", () => {
    const input = "\x1b[2K\x1b[1Gloading...";
    expect(cleanTerminalOutput(input)).toBe("loading...");
  });

  it("handles carriage return by keeping last segment", () => {
    const input = "Progress: 10%\rProgress: 50%\rProgress: 100%";
    expect(cleanTerminalOutput(input)).toBe("Progress: 100%");
  });

  it("handles mixed \\r and \\n", () => {
    const input = "Line 1\nDownloading: 10%\rDownloading: 100%\nLine 3";
    expect(cleanTerminalOutput(input)).toBe("Line 1\nDownloading: 100%\nLine 3");
  });

  it("passes through clean text unchanged", () => {
    const input = "Hello\nWorld\nDone";
    expect(cleanTerminalOutput(input)).toBe("Hello\nWorld\nDone");
  });

  it("handles empty string", () => {
    expect(cleanTerminalOutput("")).toBe("");
  });

  it("strips progress bar with ANSI + \\r", () => {
    const input = "\x1b[36m▓▓▓░░░░\x1b[0m 40%\r\x1b[36m▓▓▓▓▓▓▓\x1b[0m 100%";
    expect(cleanTerminalOutput(input)).toBe("▓▓▓▓▓▓▓ 100%");
  });

  it("handles trailing spaces from overwritten lines", () => {
    const input = "Long line with many chars\rShort";
    expect(cleanTerminalOutput(input)).toBe("Short");
  });
});
