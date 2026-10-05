// Types for the NoSleep OpenCode plugin (nosleep.js). The plugin itself ships
// as dependency-free JS so OpenCode can load it straight from
// .opencode/plugins/ without a bun install step.

export interface NoSleepPluginInput {
  /** OpenCode PluginInput fields the plugin uses. */
  readonly directory?: string;
  readonly worktree?: string;
  readonly client?: {
    session?: {
      prompt?: (args: {
        path: { id: string };
        body: { parts: Array<{ type: "text"; text: string }> };
      }) => Promise<unknown>;
    };
  };
  /** Test seams (OpenCode never sets these). */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly env?: Record<string, string | undefined>;
  readonly configPath?: string;
  readonly [key: string]: unknown;
}

export type NoSleepHook = (input: any, output: any) => Promise<void>;

export interface NoSleepHooks {
  "tool.execute.before"?: NoSleepHook;
  "tool.execute.after"?: NoSleepHook;
  "chat.message"?: NoSleepHook;
  "experimental.chat.system.transform"?: NoSleepHook;
  "experimental.session.compacting"?: NoSleepHook;
  event?: (input: { event: { type: string; properties?: any } }) => Promise<void>;
}

export declare const NoSleepPlugin: (input?: NoSleepPluginInput) => Promise<NoSleepHooks>;
