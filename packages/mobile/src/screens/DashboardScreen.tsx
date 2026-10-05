import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  SectionList,
  RefreshControl,
  Pressable,
  Switch,
  StyleSheet,
  Alert as RNAlert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { listOrgs, listSessions, listProjects, updateProject, interveneSession } from "../services/api";
import { wsManager } from "../services/ws";
import { useRefresh } from "../hooks/useRefresh";
import { useWsEvent } from "../hooks/useWsEvent";
import { colors, getOrgColor, ORG_NAMES } from "../theme";
import type { OrgWithStats, SessionWithProject, Project } from "../types";

interface OrgSection {
  readonly orgId: string;
  readonly orgName: string;
  readonly orgColor: string;
  readonly activeSessions: number;
  readonly unackedAlerts: number;
  readonly data: readonly Project[];
}

type TabParamList = {
  Dashboard: undefined;
  Projects: undefined;
  Alerts: undefined;
  Settings: undefined;
};

export function DashboardScreen(): React.JSX.Element {
  const navigation = useNavigation<BottomTabNavigationProp<TabParamList>>();
  const [sections, setSections] = useState<OrgSection[]>([]);
  const [totalUnackedAlerts, setTotalUnackedAlerts] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [runningSessions, setRunningSessions] = useState<Map<string, SessionWithProject[]>>(new Map());

  const loadData = useCallback(async () => {
    try {
      const [orgs, projects, sessions] = await Promise.all([
        listOrgs(),
        listProjects(),
        listSessions({ status: "running" }),
      ]);

      // Group running sessions by project ID
      const sessionsByProject = new Map<string, SessionWithProject[]>();
      for (const s of sessions) {
        const pid = s.projectId ?? (s as any).project_id;
        if (!pid) continue;
        const existing = sessionsByProject.get(pid) ?? [];
        sessionsByProject.set(pid, [...existing, s]);
      }
      setRunningSessions(sessionsByProject);

      let unackedTotal = 0;
      const orgSections: OrgSection[] = orgs.map((org: OrgWithStats) => {
        unackedTotal += org.unackedAlerts ?? 0;
        const orgProjects = projects.filter(
          (p: Project) => p.orgId === org.id
        );
        return {
          orgId: org.id,
          orgName: org.name,
          orgColor: getOrgColor(org.id),
          activeSessions: org.activeSessions ?? 0,
          unackedAlerts: org.unackedAlerts ?? 0,
          data: orgProjects,
        };
      });

      setTotalUnackedAlerts(unackedTotal);
      setSections(orgSections);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection failed");
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleWsUpdate = useCallback(() => {
    loadData();
  }, [loadData]);

  useWsEvent("session:update", handleWsUpdate);
  useWsEvent("alert:new", handleWsUpdate);
  useWsEvent("alert:ack", handleWsUpdate);

  const { refreshing, handleRefresh } = useRefresh(loadData);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>NoSleep</Text>
        {totalUnackedAlerts > 0 && (
          <Pressable
            style={styles.alertBadge}
            onPress={() => navigation.navigate("Alerts")}
          >
            <Text style={styles.alertBadgeText}>{totalUnackedAlerts}</Text>
          </Pressable>
        )}
      </View>

      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <Text style={styles.errorHint}>Check API key in Settings</Text>
        </View>
      )}

      <SectionList
        sections={sections as any[]}
        keyExtractor={(item) => item.id}
        renderSectionHeader={({ section }) => {
          const s = section as unknown as OrgSection;
          return (
            <View style={styles.sectionHeader}>
              <View
                style={[styles.sectionDot, { backgroundColor: s.orgColor }]}
              />
              <Text style={[styles.sectionTitle, { color: s.orgColor }]}>
                {s.orgName}
              </Text>
              {s.activeSessions > 0 && (
                <View style={[styles.sessionBadge, { backgroundColor: s.orgColor }]}>
                  <Text style={styles.sessionBadgeText}>
                    {s.activeSessions} running
                  </Text>
                </View>
              )}
              {s.unackedAlerts > 0 && (
                <View style={styles.alertSmallBadge}>
                  <Text style={styles.alertSmallBadgeText}>
                    {s.unackedAlerts}
                  </Text>
                </View>
              )}
            </View>
          );
        }}
        renderItem={({ item, section }) => {
          const s = section as unknown as OrgSection;
          const p = item as Project;
          return (
            <Pressable style={[styles.projectCard, p.active === false && styles.projectCardInactive]}>
              <View style={styles.projectHeader}>
                <Text style={[styles.projectName, p.active === false && styles.textInactive]}>{p.name}</Text>
                <Switch
                  value={p.active !== false}
                  onValueChange={(val) => {
                    updateProject(p.id, { active: val }).then(() => loadData());
                  }}
                  trackColor={{ false: colors.cardBorder, true: s.orgColor }}
                  thumbColor={colors.white}
                  style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
                />
              </View>
              <View style={styles.progressBarBg}>
                <View
                  style={[
                    styles.progressBarFill,
                    {
                      width: `${Math.min(100, p.progressPct ?? 0)}%`,
                      backgroundColor: s.orgColor,
                    },
                  ]}
                />
              </View>
              <View style={styles.projectMeta}>
                <Text style={styles.metaText}>
                  {p.autonomyLevel ?? "supervised"}
                </Text>
                <Text style={styles.metaText}>
                  {((p.tokenBudget ?? 0) / 1000).toFixed(0)}k tokens
                </Text>
              </View>

              {/* Running sessions for this project */}
              {(runningSessions.get(p.id) ?? []).map((sess) => {
                const idleSec = (sess as any).idleSeconds ?? (sess as any).idle_seconds ?? 0;
                const isIdle = idleSec > 120; // idle > 2 min
                const idleMin = Math.floor(idleSec / 60);
                const statusColor = isIdle ? colors.severityWarning : colors.success;
                const statusLabel = isIdle
                  ? `idle ${idleMin}m`
                  : "active";
                return (
                <Pressable
                  key={sess.id}
                  style={styles.sessionRow}
                  onPress={() => navigation.navigate("Terminal" as any, { sessionId: sess.id, projectName: p.name, orgId: (sess as any).orgId ?? (p as any).orgId })}
                >
                  <View style={styles.sessionInfo}>
                    <View style={[styles.sessionDot, { backgroundColor: statusColor }]} />
                    <View style={styles.sessionTextCol}>
                      <Text style={styles.sessionGoal} numberOfLines={1}>
                        {sess.goalText ?? (sess as any).goal_text ?? "Session"}
                      </Text>
                      <Text style={[styles.sessionStatus, { color: statusColor }]}>
                        {statusLabel}
                      </Text>
                    </View>
                  </View>
                  <Pressable
                    style={styles.stopButton}
                    onPress={() => {
                      RNAlert.alert("Stop Session", `Stop ${sess.id.slice(0, 12)}?`, [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Stop",
                          style: "destructive",
                          onPress: () => {
                            interveneSession(sess.id, "stop").then(() => loadData());
                          },
                        },
                      ]);
                    }}
                  >
                    <Text style={styles.stopButtonText}>Stop</Text>
                  </Pressable>
                </Pressable>
                );
              })}
            </Pressable>
          );
        }}
        renderSectionFooter={({ section }) => {
          const s = section as unknown as OrgSection;
          if (s.data.length === 0) {
            return (
              <Text style={styles.emptyText}>No projects</Text>
            );
          }
          return null;
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
  alertBadge: {
    backgroundColor: colors.danger,
    borderRadius: 12,
    minWidth: 24,
    height: 24,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 8,
  },
  alertBadgeText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: "700",
  },
  errorBanner: {
    backgroundColor: "rgba(239, 68, 68, 0.15)",
    marginHorizontal: 16,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.3)",
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: "600",
  },
  errorHint: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
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
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    flex: 1,
  },
  sessionBadge: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginRight: 6,
  },
  sessionBadgeText: {
    color: colors.white,
    fontSize: 11,
    fontWeight: "700",
  },
  alertSmallBadge: {
    backgroundColor: colors.danger,
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 5,
  },
  alertSmallBadgeText: {
    color: colors.white,
    fontSize: 11,
    fontWeight: "700",
  },
  projectCard: {
    backgroundColor: colors.card,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  projectCardInactive: {
    opacity: 0.45,
  },
  textInactive: {
    color: colors.textMuted,
  },
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
  },
  sessionInfo: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    gap: 8,
  },
  sessionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  sessionTextCol: {
    flex: 1,
  },
  sessionGoal: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  sessionStatus: {
    fontSize: 11,
    fontWeight: "600",
    marginTop: 1,
  },
  stopButton: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: `${colors.danger}20`,
    marginLeft: 8,
  },
  stopButtonText: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.danger,
  },
  projectHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  projectName: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.textPrimary,
    flex: 1,
  },
  projectStatus: {
    fontSize: 12,
    color: colors.textMuted,
    textTransform: "uppercase",
    fontWeight: "600",
  },
  progressBarBg: {
    height: 4,
    backgroundColor: colors.cardBorder,
    borderRadius: 2,
    overflow: "hidden",
    marginBottom: 8,
  },
  progressBarFill: {
    height: 4,
    borderRadius: 2,
  },
  projectMeta: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  metaText: {
    fontSize: 12,
    color: colors.textMuted,
  },
  emptyText: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: "center",
    paddingVertical: 12,
  },
  listContent: {
    paddingBottom: 20,
  },
});
