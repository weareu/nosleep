import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  RefreshControl,
  Pressable,
  StyleSheet,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { AlertItem } from "../components/AlertItem";
import { listAlerts, acknowledgeAlert, acknowledgeAllAlerts } from "../services/api";
import { useRefresh } from "../hooks/useRefresh";
import { useWsEvent } from "../hooks/useWsEvent";
import { colors, getOrgColor } from "../theme";
import { FAB_CONTENT_INSET } from "../components/GlobalMicFab";
import type { Alert, OrgSlug } from "../types";

type FilterOption = "all" | "org_personal" | "org_wyobi" | "org_apply";

const FILTERS: readonly { key: FilterOption; label: string; color: string }[] = [
  { key: "all", label: "All", color: colors.textSecondary },
  { key: "org_personal", label: "Personal", color: colors.personal },
  { key: "org_wyobi", label: "Wyobi", color: colors.wyobi },
  { key: "org_apply", label: "Apply", color: colors.apply },
] as const;

export function AlertsScreen(): React.JSX.Element {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [filter, setFilter] = useState<FilterOption>("all");

  const loadData = useCallback(async () => {
    try {
      const data = await listAlerts({
        orgId: filter === "all" ? undefined : filter,
      });
      setAlerts(data);
    } catch {
      // Keep existing data
    }
  }, [filter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleWsUpdate = useCallback(() => {
    loadData();
  }, [loadData]);

  useWsEvent("alert:new", handleWsUpdate);
  useWsEvent("alert:ack", handleWsUpdate);

  const { refreshing, handleRefresh } = useRefresh(loadData);

  const handleAcknowledge = useCallback(
    async (alertId: number) => {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      try {
        await acknowledgeAlert(alertId);
        setAlerts((prev) =>
          prev.map((a) =>
            a.id === alertId ? { ...a, acknowledged: true } : a
          )
        );
      } catch {
        // Revert on error
        loadData();
      }
    },
    [loadData]
  );

  const handleAckAll = useCallback(async () => {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    try {
      await acknowledgeAllAlerts(filter === "all" ? undefined : filter);
      setAlerts((prev) => prev.map((a) => ({ ...a, acknowledged: true })));
    } catch {
      loadData();
    }
  }, [filter, loadData]);

  const unackedCount = alerts.filter((a) => !a.acknowledged).length;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Alerts</Text>
        {unackedCount > 0 && (
          <Pressable style={styles.ackAllButton} onPress={handleAckAll}>
            <Text style={styles.ackAllText}>Ack All ({unackedCount})</Text>
          </Pressable>
        )}
      </View>

      {/* Filter chips */}
      <View style={styles.filterRow}>
        {FILTERS.map((f) => (
          <Pressable
            key={f.key}
            style={[
              styles.filterChip,
              filter === f.key && {
                backgroundColor: `${f.color}20`,
                borderColor: f.color,
              },
            ]}
            onPress={() => setFilter(f.key)}
          >
            <Text
              style={[
                styles.filterText,
                filter === f.key && { color: f.color },
              ]}
            >
              {f.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <FlatList
        data={alerts}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => (
          <AlertItem alert={item} onAcknowledge={handleAcknowledge} />
        )}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.textSecondary}
          />
        }
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No alerts</Text>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  ackAllButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  ackAllText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: "600",
  },
  filterRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.card,
  },
  filterText: {
    fontSize: 13,
    fontWeight: "500",
    color: colors.textSecondary,
  },
  listContent: {
    // Clear the floating mic button so the last rows/badges aren't covered.
    paddingBottom: FAB_CONTENT_INSET,
  },
  emptyText: {
    color: colors.textMuted,
    textAlign: "center",
    marginTop: 40,
    fontSize: 15,
  },
});
