/**
 * Per-session message queue for delivering supervision messages via hook responses.
 *
 * The core problem: Claude CLI in --print mode blocks on open stdin pipes,
 * so we must close stdin immediately. This means we can't send messages via stdin.
 *
 * Solution: Queue messages here, and drain them in the PreToolUse hook HTTP response.
 * The hook script writes the message to stdout, which Claude sees as a user-turn injection.
 */
export class SessionMessageQueue {
  private readonly queues = new Map<string, string[]>();

  /**
   * Push a message to be delivered to a session at the next PreToolUse hook call.
   */
  push(sessionId: string, message: string): void {
    const q = this.queues.get(sessionId) ?? [];
    q.push(message);
    this.queues.set(sessionId, q);
  }

  /**
   * Drain all pending messages for a session. Returns null if empty.
   * Concatenates multiple messages with separators.
   */
  drain(sessionId: string): string | null {
    const q = this.queues.get(sessionId);
    if (!q || q.length === 0) return null;
    const combined = q.join("\n\n---\n\n");
    q.length = 0;
    return combined;
  }

  /**
   * Check if there are pending messages without draining.
   */
  hasPending(sessionId: string): boolean {
    const q = this.queues.get(sessionId);
    return !!q && q.length > 0;
  }

  /**
   * Clear all messages for a session (on session end).
   */
  clear(sessionId: string): void {
    this.queues.delete(sessionId);
  }
}
