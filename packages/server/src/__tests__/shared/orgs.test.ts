import { describe, it, expect } from "vitest";
import {
  ORG_COLOR_PALETTE,
  listOrgs,
  orgApiKeyEnvName,
  paletteColorFor,
  resolveOrgColor,
  slugify,
} from "@nosleep/shared";
import { initializeDatabase } from "../../db/schema.js";

describe("org helpers", () => {
  it("falls back to a deterministic palette colour by id when the stored colour is missing/invalid", () => {
    const a = resolveOrgColor("org_client-x", null);
    expect(ORG_COLOR_PALETTE).toContain(a);
    expect(resolveOrgColor("org_client-x", "")).toBe(a);
    expect(resolveOrgColor("org_client-x", "not-a-colour")).toBe(a);
    expect(paletteColorFor("org_client-x")).toBe(a);
    expect(resolveOrgColor("org_client-x", "#123456")).toBe("#123456");
  });

  it("spreads different ids across the palette", () => {
    const colours = new Set(Array.from({ length: 40 }, (_, i) => paletteColorFor(`org_${i}`)));
    expect(colours.size).toBeGreaterThan(4);
  });

  it("maps slugs to per-org API key env names", () => {
    expect(orgApiKeyEnvName("personal")).toBe("NOSLEEP_API_KEY_PERSONAL");
    expect(orgApiKeyEnvName("client-x")).toBe("NOSLEEP_API_KEY_CLIENT_X");
  });

  it("slugifies display names", () => {
    expect(slugify("  Client X — Ltd. ")).toBe("client-x-ltd");
    expect(slugify("Ünïcode")).toBe("n-code");
  });

  it("lists rows with a colour even when the stored one is blank", () => {
    const db = initializeDatabase(":memory:");
    db.prepare(`INSERT INTO organizations (id, name, slug, color) VALUES ('org_blank', 'Blank', 'blank', '')`).run();
    const blank = listOrgs(db).find((o) => o.id === "org_blank")!;
    expect(blank.color).toBe(paletteColorFor("org_blank"));
    expect(listOrgs(db)[0].id).toBe("org_personal");
    db.close();
  });
});
