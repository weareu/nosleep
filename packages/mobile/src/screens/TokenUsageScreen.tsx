import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  StyleSheet,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { listOrgs, listSessions } from "../services/api";
import { useRefresh } from "../hooks/useRefresh";
import { useWsEvent } from "../hooks/useWsEvent";
import { colors, getOrgColor, getOrgName } from "../theme";
import { parseDateString } from "../utils";
import type { OrgWithStats, SessionWithProject } from "../types";

// ── Helpers ─────────────────────────────────────────────

const TOKEN_DAILY_LIMIT = 1_000_000;

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

function getBarColor(pct: number, orgColor: string): string {
  if (pct > 95) return colors.danger;
  if (pct > 80) return colors.severityWarning;
  return orgColor;
}

// ── Components ──────────────────────────────────────────

function BudgetBar({
  label,
  used,
  limit,
  orgColor,
}: {
  readonly label: string;
  readonly used: number;
  readonly limit: number;
  readonly orgColor: string;
}): React.JSX.Element {
  const pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  const barColor = getBarColor(pct, orgColor);

  return (
    <View style={styles.budgetBarContainer}>
      <View style={styles.budgetBarHeader}>
        <View style={[styles.orgDot, { backgroundColor: orgColor }]} />
        <Text style={styles.budgetLabel}>{label}</Text>
        <Text style={[styles.budgetPct, { color: barColor }]}>
          {Math.round(pct)}%
        </Text>
      </View>
      <View style={styles.barTrack}>
        <View
          style={[
            styles.barFill,
            { width: `${pct}%`, backgroundColor: barColor },
          ]}
        />
      </View>
      <Text style={styles.budgetDetail}>
        {formatTokens(used)} / {formatTokens(limit)}
      </Text>
    </View>
  );
}

function TopSessionRow({
  session,
}: {
  readonly session: SessionWithProject;
}): React.JSX.Element {
  const orgColor = session.orgId ? getOrgColor(session.orgId) : colors.textMuted;
  const orgName = session.orgId
    ? getOrgName(session.orgId)
    : "Unknown";

  return (
    <View style={styles.sessionRow}>
      <View style={styles.sessionInfo}>
        <Text style={styles.sessionProject} numberOfLines={1}>
          {session.projectName ?? "Unknown Project"}
        </Text>
        <View style={styles.sessionMeta}>
          <View style={[styles.orgBadge, { backgroundColor: `${orgColor}20` }]}>
            <Text style={[styles.orgBadgeText, { color: orgColor }]}>
              {orgName}
            </Text>
          </View>
          <Text style={styles.sessionStatus}>{session.status}</Text>
        </View>
      </View>
      <View style={styles.sessionTokens}>
        <Text style={styles.sessionTokenCount}>
          {formatTokens(session.tokensUsed)}
        </Text>
        <Text style={styles.sessionDate}>
          {new Date(parseDateString(session.startedAt)).toLocaleDateString()}
        </Text>
      </View>
    </View>
  );
}

// ── Screen ──────────────────────────────────────────────

export function TokenUsageScreen(): React.JSX.Element {
  const [orgs, setOrgs] = useState<readonly OrgWithStats[]>([]);
  const [topSessions, setTopSessions] = useState<readonly SessionWithProject[]>(
    []
  );

  const loadData = useCallback(async () => {
    try {
      const [orgsData, sessionsData] = await Promise.all([
        listOrgs(),
        listSessions({}),
      ]);
      setOrgs(orgsData);

      const sorted = [...sessionsData]
        .sort((a, b) => b.tokensUsed - a.tokensUsed)
        .slice(0, 10);
      setTopSessions(sorted);
    } catch {
      // Keep existing data on error
    }
  }, []);

  // Initial load
  React.useEffect(() => {
    loadData();
  }, [loadData]);

  // Refresh on WS budget updates
  const handleWsUpdate = useCallback(() => {
    loadData();
  }, [loadData]);

  useWsEvent("budget:update", handleWsUpdate);
  useWsEvent("session:update", handleWsUpdate);

  const { refreshing, handleRefresh } = useRefresh(loadData);

  const totalTokensToday = orgs.reduce(
    (sum, org) => sum + (org.todayTokens ?? 0),
    0
  );

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Token Usage</Text>
        <Text style={styles.headerSubtitle}>
          Monitor token consumption across all accounts
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.textSecondary}
          />
        }
      >
        {/* Total summary */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Today's Total</Text>
          <Text style={styles.totalTokens}>{formatTokens(totalTokensToday)}</Text>
          <Text style={styles.totalLimit}>
            of {formatTokens(TOKEN_DAILY_LIMIT * orgs.length)} combined budget
          </Text>
        </View>

        {/* Budget bars per org */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Budget Status (Today)</Text>
          {orgs.length === 0 ? (
            <Text style={styles.emptyText}>No organizations found</Text>
          ) : (
            orgs.map((org) => (
              <BudgetBar
                key={org.id}
                label={org.name}
                used={org.todayTokens ?? 0}
                limit={TOKEN_DAILY_LIMIT}
                orgColor={getOrgColor(org.id)}
              />
            ))
          )}
        </View>

        {/* Top sessions */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Top Sessions by Token Usage</Text>
          {topSessions.length === 0 ? (
            <Text style={styles.emptyText}>No sessions recorded</Text>
          ) : (
            topSessions.map((session) => (
              <TopSessionRow key={session.id} session={session} />
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Styles ──────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  headerSubtitle: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 32,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textSecondary,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginBottom: 12,
  },
  totalTokens: {
    fontSize: 36,
    fontWeight: "800",
    color: colors.textPrimary,
    textAlign: "center",
  },
  totalLimit: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: "center",
    marginTop: 4,
  },
  emptyText: {
    color: colors.textMuted,
    textAlign: "center",
    paddingVertical: 12,
    fontSize: 14,
  },

  // Budget bar
  budgetBarContainer: {
    marginBottom: 16,
  },
  budgetBarHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 6,
  },
  orgDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  budgetLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
    color: colors.textPrimary,
  },
  budgetPct: {
    fontSize: 14,
    fontWeight: "700",
  },
  barTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: 4,
  },
  budgetDetail: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 4,
  },

  // Top sessions
  sessionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: `${colors.cardBorder}40`,
  },
  sessionInfo: {
    flex: 1,
    marginRight: 12,
  },
  sessionProject: {
    fontSize: 14,
    fontWeight: "500",
    color: colors.textPrimary,
  },
  sessionMeta: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 4,
    gap: 8,
  },
  orgBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  orgBadgeText: {
    fontSize: 11,
    fontWeight: "600",
  },
  sessionStatus: {
    fontSize: 11,
    color: colors.textMuted,
    textTransform: "capitalize",
  },
  sessionTokens: {
    alignItems: "flex-end",
  },
  sessionTokenCount: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textPrimary,
    fontVariant: ["tabular-nums"],
  },
  sessionDate: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 2,
  },
});
