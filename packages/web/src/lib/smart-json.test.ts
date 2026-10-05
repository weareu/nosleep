import { describe, it, expect } from "vitest";
import { looksLikeJson, smartLabel, stripMarkdownSyntax, tryParseJson } from "./smart-json";

describe("smartLabel", () => {
  it("extracts tool name + description from a full tool_call payload", () => {
    const s = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "git push", description: "Deploy the login fix" },
    });
    const r = smartLabel(s);
    expect(r.fromJson).toBe(true);
    expect(r.kind).toBe("Bash");
    expect(r.label).toBe("Deploy the login fix");
  });

  it("falls back to the command when no description exists", () => {
    const s = JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls -la" } });
    const r = smartLabel(s);
    expect(r.kind).toBe("Bash");
    expect(r.label).toBe("ls -la");
  });

  it("recovers name fields from TRUNCATED json via the regex fallback", () => {
    const full = JSON.stringify({
      tool_name: "Bash",
      tool_input: { description: "Restart the server", command: "launchctl kickstart" },
    });
    const truncated = full.slice(0, full.indexOf("command") + 12); // cut mid-payload
    const r = smartLabel(truncated);
    expect(r.fromJson).toBe(true);
    expect(r.kind).toBe("Bash");
    expect(r.label).toBe("Restart the server");
  });

  it("passes prose through with markdown syntax stripped", () => {
    const r = smartLabel("## **COMPREHENSIVE REVIEW** of `example.py`");
    expect(r.fromJson).toBe(false);
    expect(r.kind).toBeUndefined();
    expect(r.label).toBe("COMPREHENSIVE REVIEW of example.py");
  });

  it("returns the raw text when JSON has no recognisable name fields", () => {
    const s = JSON.stringify({ a: 1, b: [2, 3] });
    const r = smartLabel(s);
    expect(r.label).toBe(s);
  });
});

describe("tryParseJson / looksLikeJson", () => {
  it("parses valid json and rejects truncated json", () => {
    expect(tryParseJson('{"x":1}')).toEqual({ x: 1 });
    expect(tryParseJson('{"x":1')).toBeUndefined();
    expect(tryParseJson("plain text")).toBeUndefined();
  });

  it("looksLikeJson keys on the leading brace/bracket only", () => {
    expect(looksLikeJson("  {broken")).toBe(true);
    expect(looksLikeJson("[1,2]")).toBe(true);
    expect(looksLikeJson("# heading")).toBe(false);
  });
});

describe("stripMarkdownSyntax", () => {
  it("removes headings, bold, italics and inline code markers", () => {
    expect(stripMarkdownSyntax("### **Bold** and *em* and `code`")).toBe(
      "Bold and em and code",
    );
  });
});
