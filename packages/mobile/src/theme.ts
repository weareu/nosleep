import { StyleSheet } from "react-native";

// ── Colors ──────────────────────────────────────────────

export const colors = {
  // Background
  bg: "#0f172a",         // slate-900
  card: "#1e293b",       // slate-800
  cardBorder: "#334155", // slate-700
  surface: "#334155",    // slate-700

  // Text
  textPrimary: "#f8fafc",   // slate-50
  textSecondary: "#94a3b8", // slate-400
  textMuted: "#64748b",     // slate-500

  // Org colors
  personal: "#6366f1", // indigo
  wyobi: "#f59e0b",    // amber
  apply: "#10b981",    // emerald

  // Status colors
  statusStarting: "#60a5fa",  // blue-400
  statusRunning: "#34d399",   // emerald-400
  statusIdle: "#94a3b8",      // slate-400
  statusWaiting: "#fbbf24",   // amber-400
  statusPaused: "#a78bfa",    // violet-400
  statusCompleted: "#10b981", // emerald-500
  statusFailed: "#ef4444",    // red-500
  statusStopped: "#6b7280",   // gray-500

  // Severity
  severityInfo: "#60a5fa",
  severityWarning: "#f59e0b",
  severityCritical: "#ef4444",

  // Actions
  danger: "#ef4444",
  success: "#10b981",
  primary: "#6366f1",

  // Misc
  white: "#ffffff",
  black: "#000000",
  transparent: "transparent",
} as const;

/**
 * Bottom tab bar height ABOVE the safe-area inset. Tall enough for the
 * 24px icon + a 14px label line + item padding — react-navigation's 49px
 * default squeezed the label box to 10px and clipped descenders
 * ("Proiects"). The floating mic button positions itself from this too.
 */
export const TAB_BAR_HEIGHT = 58;

export const ORG_COLORS: Record<string, string> = {
  org_personal: colors.personal,
  org_wyobi: colors.wyobi,
  org_apply: colors.apply,
};

export const ORG_NAMES: Record<string, string> = {
  org_personal: "Personal",
  org_wyobi: "Wyobi",
  org_apply: "Apply",
};

export function getStatusColor(status: string): string {
  const map: Record<string, string> = {
    starting: colors.statusStarting,
    running: colors.statusRunning,
    idle: colors.statusIdle,
    waiting_input: colors.statusWaiting,
    paused: colors.statusPaused,
    completed: colors.statusCompleted,
    failed: colors.statusFailed,
    stopped: colors.statusStopped,
  };
  return map[status] ?? colors.textMuted;
}

export function getSeverityColor(severity: string): string {
  const map: Record<string, string> = {
    info: colors.severityInfo,
    warning: colors.severityWarning,
    critical: colors.severityCritical,
  };
  return map[severity] ?? colors.textMuted;
}

export function getOrgColor(orgId: string): string {
  return ORG_COLORS[orgId] ?? colors.textMuted;
}

// ── Common Styles ───────────────────────────────────────

export const commonStyles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  screenPadded: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: 16,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  spaceBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: {
    fontSize: 17,
    fontWeight: "600",
    color: colors.textPrimary,
  },
  subtitle: {
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: 2,
  },
  caption: {
    fontSize: 12,
    color: colors.textMuted,
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 8,
  },
});
