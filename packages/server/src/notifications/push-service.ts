import type Database from "better-sqlite3";
import type { Alert } from "@nosleep/shared";
import { nanoid } from "nanoid";

// ── Push Notification Backend Interface ─────────────────

export interface PushAlert {
  readonly title: string;
  readonly body: string;
  readonly data?: Record<string, unknown>;
}

export interface PushBackend {
  sendAlert(pushToken: string, alert: PushAlert): Promise<boolean>;
}

// ── Device Token Store ──────────────────────────────────

interface PushDevice {
  readonly id: string;
  readonly push_token: string;
  readonly org_filter: string | null;
  readonly platform: string;
  readonly created_at: string;
}

// ── Expo Push Backend ───────────────────────────────────

export class ExpoPushBackend implements PushBackend {
  private readonly expoUrl = "https://exp.host/--/api/v2/push/send";

  async sendAlert(pushToken: string, alert: PushAlert): Promise<boolean> {
    try {
      const response = await fetch(this.expoUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          to: pushToken,
          title: alert.title,
          body: alert.body,
          data: alert.data ?? {},
          sound: "default",
          priority: "high",
        }),
      });

      if (!response.ok) {
        return false;
      }

      const result = (await response.json()) as {
        data?: { status?: string };
      };
      return result.data?.status === "ok";
    } catch {
      return false;
    }
  }
}

// ── Push Service ────────────────────────────────────────

export class PushService {
  private readonly db: Database.Database;
  private readonly backend: PushBackend;

  constructor(db: Database.Database, backend?: PushBackend) {
    this.db = db;
    this.backend = backend ?? new ExpoPushBackend();
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS push_devices (
        id TEXT PRIMARY KEY,
        push_token TEXT NOT NULL UNIQUE,
        org_filter TEXT,
        platform TEXT DEFAULT 'ios',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  registerDevice(
    pushToken: string,
    orgFilter?: string | null,
    platform?: string,
  ): { id: string } {
    const existing = this.db
      .prepare("SELECT id FROM push_devices WHERE push_token = ?")
      .get(pushToken) as PushDevice | undefined;

    if (existing) {
      this.db
        .prepare(
          "UPDATE push_devices SET org_filter = ?, platform = ? WHERE push_token = ?",
        )
        .run(orgFilter ?? null, platform ?? "ios", pushToken);
      return { id: existing.id };
    }

    const id = nanoid();
    this.db
      .prepare(
        "INSERT INTO push_devices (id, push_token, org_filter, platform) VALUES (?, ?, ?, ?)",
      )
      .run(id, pushToken, orgFilter ?? null, platform ?? "ios");
    return { id };
  }

  unregisterDevice(pushToken: string): void {
    this.db
      .prepare("DELETE FROM push_devices WHERE push_token = ?")
      .run(pushToken);
  }

  async sendAlertToAll(alert: Alert): Promise<number> {
    const devices = this.getDevicesForOrg(alert.orgId);
    let sentCount = 0;

    const pushAlert: PushAlert = {
      title: `[${alert.severity.toUpperCase()}] ${alert.type}`,
      body: alert.message,
      data: {
        alertId: alert.id,
        orgId: alert.orgId,
        sessionId: alert.sessionId,
        projectId: alert.projectId,
        type: alert.type,
        severity: alert.severity,
      },
    };

    const results = await Promise.allSettled(
      devices.map(async (device) => {
        const ok = await this.backend.sendAlert(device.push_token, pushAlert);
        if (ok) sentCount++;
        return ok;
      }),
    );

    return sentCount;
  }

  private getDevicesForOrg(orgId: string): PushDevice[] {
    return this.db
      .prepare(
        "SELECT * FROM push_devices WHERE org_filter IS NULL OR org_filter = ?",
      )
      .all(orgId) as PushDevice[];
  }
}
