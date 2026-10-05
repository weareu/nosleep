import { EventEmitter } from "node:events";
import type {
  Session,
  Alert,
  TokenUsage,
  Goal,
  ValidationResult,
  PacingMode,
  WsEventType,
} from "@nosleep/shared";

/**
 * Central event bus for all NoSleep internal events.
 * Components publish here, WebSocket broadcaster and other consumers subscribe.
 */

interface SessionRejectedData {
  readonly projectId: string;
  readonly accountId: string;
  readonly reason?: string;
  readonly suggestion?: string;
  readonly pacingMode: PacingMode;
}

interface EscalationData {
  readonly escalationId: string;
  readonly question: string;
  readonly reason: string;
  readonly confidence: number;
}

interface NoSleepEvents {
  "session:update": [session: Session];
  "session:output": [sessionId: string, text: string];
  "session:rejected": [data: SessionRejectedData];
  "alert:new": [alert: Alert];
  "alert:ack": [alertId: number];
  "alert:unack": [alertId: number];
  "budget:update": [usage: TokenUsage];
  "validation:result": [result: ValidationResult];
  "goal:progress": [goal: Goal];
  "supervision:auto-continue": [sessionId: string, questionText: string];
  "supervision:goal-injected": [sessionId: string];
  "supervision:drift-detected": [sessionId: string, confidence: number, reason: string];
  "supervision:compaction-recovery": [sessionId: string];
  "supervision:auto-retry": [sessionId: string, attempt: number];
  "supervision:auto-advance": [sessionId: string, nextNodeId: string];
  "supervision:escalation": [sessionId: string, data: EscalationData];
  "supervision:human-response": [sessionId: string, response: string];
  "plan:detected": [event: { filePath: string; projectId: string; orgId: string; sessionId: string }];
}

class TypedEventEmitter extends EventEmitter {
  emit<K extends keyof NoSleepEvents>(event: K, ...args: NoSleepEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  on<K extends keyof NoSleepEvents>(event: K, listener: (...args: NoSleepEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof NoSleepEvents>(event: K, listener: (...args: NoSleepEvents[K]) => void): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}

export const eventBus = new TypedEventEmitter();
eventBus.setMaxListeners(50);
