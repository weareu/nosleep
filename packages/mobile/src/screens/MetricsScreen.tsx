import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Pressable,
  StyleSheet,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { fetchMetrics, listOrgs, type MetricsSnapshot } from "../services/api";
import { useRefresh } from "../hooks/useRefresh";
import { colors, getOrgColor, ORG_NAMES } from "../theme";
import type { OrgWithStats } from "../types";

const WINDOWS = [
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
];

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export function MetricsScreen(): React.JSX.Element {
  const [windowHours, setWindowHours] = useState<number>(24);
  const [orgFilter, setOrgFilter] = useState<string>("");
  const [orgs, setOrgs] = useState<OrgWithStats[]>([]);
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [snap, orgList] = await Promise.all([
        fetchMetrics({ windowHours, orgId: orgFilter || undefined }),
        listOrgs(),
      ]);
      setSnapshot(snap);
      setOrgs(orgList);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [windowHours, orgFilter]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  const { refreshing, handleRefresh } = useRefresh(load);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Metrics</Text>
      </View>

      <View style={styles.filterRow}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterScrollContent}
        >
          <Pressable
            style={[styles.filterChip, !orgFilter && styles.filterChipActive]}
            onPress={() => setOrgFilter("")}
          >
            <Text style={[styles.filterChipText, !orgFilter && styles.filterChipTextActive]}>All</Text>
          </Pressable>
          {orgs.map((o) => (
            <Pressable
              key={o.id}
              style={[
                styles.filterChip,
                orgFilter === o.id && { ...styles.filterChipActive, borderColor: getOrgColor(o.id) },
              ]}
              onPress={() => setOrgFilter(o.id)}
            >
              <View style={[styles.dot, { backgroundColor: getOrgColor(o.id) }]} />
              <Text
                style={[
                  styles.filterChipText,
                  orgFilter === o.id && styles.filterChipTextActive,
                ]}
              >
                {ORG_NAMES[o.id] ?? o.name}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      <View style={styles.windowRow}>
        {WINDOWS.map((w) => (
          <Pressable
            key={w.hours}
            style={[styles.windowChip, windowHours === w.hours && styles.windowChipActive]}
            onPress={() => setWindowHours(w.hours)}
          >
            <Text
              style={[
                styles.windowChipText,
                windowHours === w.hours && styles.windowChipTextActive,
              ]}
            >
              {w.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.textSecondary} />}
      >
        {error && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {snapshot && (
          <>
            <View style={styles.cardGrid}>
              <Card title="Sessions" big={formatNumber(snapshot.sessions.total)} sub={`in ${snapshot.windowHours}h`} />
              <Card title="Tokens" big={formatNumber(snapshot.tokens.total)} sub={`${formatNumber(snapshot.tokens.velocityPerHour)}/h`} />
              <Card title="Drift" big={String(snapshot.drift.alertCount)} sub={`${snapshot.drift.perSession.toFixed(2)}/sess`} />
              <Card title="Escalations" big={String(snapshot.escalations.alertCount)} sub={`${snapshot.escalations.perSession.toFixed(2)}/sess`} />
            </View>

            <Text style={styles.sectionTitle}>
              Session Duration ({snapshot.sessions.durationSeconds.count} completed)
            </Text>
            <View style={styles.statRow}>
              <Stat label="p50" value={formatDuration(snapshot.sessions.durationSeconds.p50)} />
              <Stat label="p95" value={formatDuration(snapshot.sessions.durationSeconds.p95)} />
              <Stat label="max" value={formatDuration(snapshot.sessions.durationSeconds.max)} />
              <Stat label="avg" value={formatDuration(snapshot.sessions.durationSeconds.avg)} />
            </View>

            {Object.keys(snapshot.validation).length > 0 && (
              <>
                <Text style={styles.sectionTitle}>Validation Outcomes</Text>
                <View style={styles.validationRow}>
                  {Object.entries(snapshot.validation).map(([verdict, count]) => {
                    const color =
                      verdict === "complete"
                        ? colors.success
                        : verdict === "stub"
                          ? colors.danger
                          : colors.severityWarning;
                    return (
                      <View key={verdict} style={styles.validationItem}>
                        <Text style={[styles.validationCount, { color }]}>{count}</Text>
                        <Text style={styles.validationLabel}>{verdict}</Text>
                      </View>
                    );
                  })}
                </View>
              </>
            )}

            <Text style={styles.footer}>
              {new Date(snapshot.generatedAt).toLocaleTimeString()} · auto-refresh 30s
            </Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Card(props: { title: string; big: string; sub: string }): React.JSX.Element {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{props.title}</Text>
      <Text style={styles.cardBig}>{props.big}</Text>
      <Text style={styles.cardSub}>{props.sub}</Text>
    </View>
  );
}

function Stat(props: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.statCol}>
      <Text style={styles.statValue}>{props.value}</Text>
      <Text style={styles.statLabel}>{props.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  filterRow: {
    paddingHorizontal: 16,
    paddingBottom: 6,
  },
  filterScrollContent: {
    gap: 8,
    paddingRight: 16,
  },
  filterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.card,
  },
  filterChipActive: {
    borderColor: colors.primary,
    backgroundColor: `${colors.primary}20`,
  },
  filterChipText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
  filterChipTextActive: {
    color: colors.textPrimary,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  windowRow: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  windowChip: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.card,
    alignItems: "center",
  },
  windowChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  windowChipText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "700",
  },
  windowChipTextActive: {
    color: colors.white,
  },
  scroll: {
    padding: 16,
    paddingBottom: 40,
  },
  errorBanner: {
    backgroundColor: `${colors.danger}20`,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: `${colors.danger}40`,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: "600",
  },
  cardGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  card: {
    flexBasis: "48%",
    flexGrow: 1,
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  cardTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  cardBig: {
    fontSize: 26,
    fontWeight: "800",
    color: colors.textPrimary,
    marginTop: 6,
  },
  cardSub: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 20,
    marginBottom: 8,
  },
  statRow: {
    flexDirection: "row",
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  statCol: {
    flex: 1,
    alignItems: "center",
  },
  statValue: {
    fontSize: 18,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  statLabel: {
    fontSize: 11,
    color: colors.textMuted,
    textTransform: "uppercase",
    marginTop: 2,
    letterSpacing: 0.5,
  },
  validationRow: {
    flexDirection: "row",
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  validationItem: {
    flex: 1,
    alignItems: "center",
  },
  validationCount: {
    fontSize: 22,
    fontWeight: "800",
  },
  validationLabel: {
    fontSize: 11,
    color: colors.textMuted,
    textTransform: "uppercase",
    marginTop: 2,
  },
  footer: {
    fontSize: 11,
    color: colors.textMuted,
    textAlign: "center",
    marginTop: 18,
  },
});
