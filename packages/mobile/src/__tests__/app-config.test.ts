import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const appJsonPath = path.resolve(__dirname, "../../app.json");
const appJson = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));
const expo = appJson.expo;

describe("app.json configuration", () => {
  describe("NSAppTransportSecurity", () => {
    it("has NSAllowsArbitraryLoads set to true for Tailscale connectivity", () => {
      const ats = expo.ios?.infoPlist?.NSAppTransportSecurity;
      expect(ats).toBeDefined();
      expect(ats.NSAllowsArbitraryLoads).toBe(true);
    });
  });

  describe("iOS bundle identifier", () => {
    it("defaults to dev.nosleep.app (override via NOSLEEP_BUNDLE_ID)", () => {
      expect(expo.ios?.bundleIdentifier).toBe("dev.nosleep.app");
    });
  });

  describe("URL scheme", () => {
    it("is nosleep", () => {
      expect(expo.scheme).toBe("nosleep");
    });
  });
});
