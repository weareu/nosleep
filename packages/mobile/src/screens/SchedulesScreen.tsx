import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  SectionList,
  RefreshControl,
  Switch,
  StyleSheet,
  Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { listOrgs, listScheduledTasks, updateScheduledTask } from "../services/api";
import { useRefresh } from "../hooks/useRefresh";
import { colors, getOrgColor, getOrgName } from "../theme";

interface ScheduledTask {
  readonly id: string;
  readonly projectId: string;
  readonly orgId: string;
  readonly name: string;
  readonly cronHour: number;
  readonly cronMinute: number;
  readonly daysOfWeek: string;
  readonly taskType: string;
  readonly enabled: number | boolean;
  readonly lastRunAt: string | null;
  readonly nextRunAt: string | null;
}

interface TaskSection {
  readonly title: string;
  readonly orgId: string;
  readonly orgColor: string;
  readonly projectId: string;
  readonly data: ScheduledTask[];
}

function formatTime(hour: number, minute: number): string {
  const h = hour.toString().padStart(2, "0");
  const m = minute.toString().padStart(2, "0");
  return `${h}:${m}`;
}

function formatDays(days: string): string {
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const nums = days.split(",").map((d) => parseInt(d.trim(), 10));
  if (nums.length === 5 && !nums.includes(0) && !nums.includes(6)) return "Weekdays";
  if (nums.length === 7) return "Daily";
  return nums.map((n) => dayNames[n] ?? n).join(", ");
}

export function SchedulesScreen(): React.JSX.Element {
  const [sections, setSections] = useState<TaskSection[]>([]);
  const [disablingAll, setDisablingAll] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [tasks, orgs] = await Promise.all([listScheduledTasks(), listOrgs()]);

      // Group by project
      const grouped = new Map<string, { orgId: string; tasks: ScheduledTask[] }>();
      for (const t of tasks) {
        const pid = t.projectId ?? t.project_id;
        const oid = t.orgId ?? t.org_id;
        const existing = grouped.get(pid);
        if (existing) {
          existing.tasks.push(t);
        } else {
          grouped.set(pid, { orgId: oid, tasks: [t] });
        }
      }

      // Build sections sorted by org
      const result: TaskSection[] = [];
      const groupOrgIds = [...new Set([...grouped.values()].map((g) => g.orgId))];
      const orgOrder = [
        ...orgs.map((o) => o.id),
        ...groupOrgIds.filter((id) => !orgs.some((o) => o.id === id)),
      ];
      for (const orgId of orgOrder) {
        for (const [projectId, group] of grouped.entries()) {
          if (group.orgId !== orgId) continue;
          // Use project name from first task or fallback
          const projectName = (group.tasks[0] as any)?.projectName
            ?? (group.tasks[0] as any)?.project_name
            ?? projectId.slice(0, 12);
          result.push({
            title: `${getOrgName(orgId)} / ${projectName}`,
            orgId,
            orgColor: getOrgColor(orgId),
            projectId,
            data: group.tasks,
          });
        }
      }

      setSections(result);
    } catch {
      // keep existing
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const { refreshing, handleRefresh } = useRefresh(loadData);

  const handleToggle = useCallback(
    async (taskId: string, enabled: boolean) => {
      try {
        await updateScheduledTask(taskId, { enabled });
        await loadData();
      } catch {
        // revert on error
        await loadData();
      }
    },
    [loadData],
  );

  const handleDisableAll = useCallback(async () => {
    setDisablingAll(true);
    try {
      const allTasks = sections.flatMap((s) => s.data);
      const enabled = allTasks.filter((t) => !!t.enabled);
      const allEnabled = enabled.length > 0;

      await Promise.all(
        allTasks.map((t) =>
          updateScheduledTask(t.id, { enabled: !allEnabled }),
        ),
      );
      await loadData();
    } finally {
      setDisablingAll(false);
    }
  }, [sections, loadData]);

  const allTasks = sections.flatMap((s) => s.data);
  const enabledCount = allTasks.filter((t) => !!t.enabled).length;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.headerTitle}>Schedules</Text>
          <Text style={styles.headerCount}>
            {enabledCount}/{allTasks.length} active
          </Text>
        </View>
        <Pressable
          style={[styles.bulkButton, disablingAll && { opacity: 0.5 }]}
          onPress={handleDisableAll}
          disabled={disablingAll}
        >
          <Text style={styles.bulkButtonText}>
            {enabledCount > 0 ? "Disable All" : "Enable All"}
          </Text>
        </Pressable>
      </View>

      <SectionList
        sections={sections as any[]}
        keyExtractor={(item) => item.id}
        renderSectionHeader={({ section }) => {
          const s = section as unknown as TaskSection;
          const sectionEnabled = s.data.filter((t) => !!t.enabled).length;
          return (
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionDot, { backgroundColor: s.orgColor }]} />
              <Text style={[styles.sectionTitle, { color: s.orgColor }]} numberOfLines={1}>
                {s.title}
              </Text>
              <Text style={styles.sectionCount}>
                {sectionEnabled}/{s.data.length}
              </Text>
            </View>
          );
        }}
        renderItem={({ item }) => {
          const task = item as ScheduledTask;
          const isEnabled = !!task.enabled;
          return (
            <View style={[styles.taskCard, !isEnabled && styles.taskCardDisabled]}>
              <View style={styles.taskRow}>
                <View style={styles.taskInfo}>
                  <Text style={[styles.taskName, !isEnabled && styles.textMuted]}>
                    {task.name}
                  </Text>
                  <Text style={styles.taskSchedule}>
                    {formatTime(task.cronHour, task.cronMinute)} {formatDays(task.daysOfWeek)}
                  </Text>
                  {task.lastRunAt && (
                    <Text style={styles.taskLastRun}>
                      Last: {new Date(task.lastRunAt).toLocaleDateString()}
                    </Text>
                  )}
                </View>
                <Switch
                  value={isEnabled}
                  onValueChange={(val) => handleToggle(task.id, val)}
                  trackColor={{ false: colors.cardBorder, true: colors.success }}
                  thumbColor={colors.white}
                  style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
                />
              </View>
            </View>
          );
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.textSecondary}
          />
        }
        stickySectionHeadersEnabled={false}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No scheduled tasks</Text>
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
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  headerCount: {
    fontSize: 14,
    color: colors.textMuted,
    fontWeight: "600",
  },
  bulkButton: {
    marginTop: 8,
    backgroundColor: `${colors.danger}20`,
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: "center",
  },
  bulkButtonText: {
    color: colors.danger,
    fontSize: 14,
    fontWeight: "700",
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 10,
  },
  sectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    flex: 1,
  },
  sectionCount: {
    fontSize: 12,
    color: colors.textMuted,
    fontWeight: "600",
  },
  taskCard: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  taskCardDisabled: {
    opacity: 0.45,
  },
  taskRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  taskInfo: {
    flex: 1,
    marginRight: 12,
  },
  taskName: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.textPrimary,
  },
  textMuted: {
    color: colors.textMuted,
  },
  taskSchedule: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  },
  taskLastRun: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 2,
  },
  listContent: {
    paddingBottom: 20,
  },
  emptyText: {
    color: colors.textMuted,
    textAlign: "center",
    marginTop: 40,
    fontSize: 15,
  },
});
