import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  SectionList,
  RefreshControl,
  Pressable,
  StyleSheet,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { OrgBadge } from "../components/OrgBadge";
import { StatusDot } from "../components/StatusDot";
import { listProjects } from "../services/api";
import { useRefresh } from "../hooks/useRefresh";
import { colors, getOrgColor, ORG_NAMES } from "../theme";
import type { Project } from "../types";

interface ProjectSection {
  readonly title: string;
  readonly orgId: string;
  readonly orgColor: string;
  readonly data: readonly Project[];
}

export function ProjectsScreen(): React.JSX.Element {
  const navigation = useNavigation();
  const [sections, setSections] = useState<ProjectSection[]>([]);

  const loadData = useCallback(async () => {
    try {
      const projects = await listProjects();

      // Group by org
      const grouped = new Map<string, Project[]>();
      for (const project of projects) {
        const existing = grouped.get(project.orgId) ?? [];
        grouped.set(project.orgId, [...existing, project]);
      }

      const orgOrder = ["org_personal", "org_wyobi", "org_apply"];
      const result: ProjectSection[] = orgOrder
        .filter((orgId) => grouped.has(orgId))
        .map((orgId) => ({
          title: ORG_NAMES[orgId] ?? orgId,
          orgId,
          orgColor: getOrgColor(orgId),
          data: grouped.get(orgId) ?? [],
        }));

      setSections(result);
    } catch {
      // Keep existing data
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const { refreshing, handleRefresh } = useRefresh(loadData);

  const navigateToLaunch = useCallback(
    (project: Project) => {
      (navigation as any).navigate("Launch", {
        projectId: project.id,
        projectName: project.name,
      });
    },
    [navigation]
  );

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Projects</Text>
      </View>

      <SectionList
        sections={sections as any[]}
        keyExtractor={(item) => item.id}
        renderSectionHeader={({ section }) => {
          const s = section as unknown as ProjectSection;
          return (
            <View style={styles.sectionHeader}>
              <View
                style={[styles.sectionDot, { backgroundColor: s.orgColor }]}
              />
              <Text style={[styles.sectionTitle, { color: s.orgColor }]}>
                {s.title}
              </Text>
            </View>
          );
        }}
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [
              styles.projectCard,
              pressed && styles.projectCardPressed,
            ]}
            onPress={() => navigateToLaunch(item)}
          >
            <View style={styles.projectHeader}>
              <StatusDot status={item.status} size={8} />
              <Text style={styles.projectName}>{item.name}</Text>
              <View
                style={[
                  styles.autonomyBadge,
                  {
                    backgroundColor:
                      item.autonomyLevel === "full"
                        ? `${colors.success}20`
                        : item.autonomyLevel === "supervised"
                          ? `${colors.wyobi}20`
                          : `${colors.textMuted}20`,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.autonomyText,
                    {
                      color:
                        item.autonomyLevel === "full"
                          ? colors.success
                          : item.autonomyLevel === "supervised"
                            ? colors.wyobi
                            : colors.textMuted,
                    },
                  ]}
                >
                  {item.autonomyLevel}
                </Text>
              </View>
            </View>
            <Text style={styles.projectPath} numberOfLines={1}>
              {item.path}
            </Text>
          </Pressable>
        )}
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
          <Text style={styles.emptyText}>No projects configured</Text>
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
  headerTitle: {
    fontSize: 28,
    fontWeight: "800",
    color: colors.textPrimary,
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
  },
  projectCard: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  projectCardPressed: {
    opacity: 0.7,
  },
  projectHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 6,
  },
  projectName: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.textPrimary,
    marginLeft: 8,
    flex: 1,
  },
  autonomyBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  autonomyText: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
  },
  projectPath: {
    fontSize: 13,
    color: colors.textMuted,
    marginLeft: 32,
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
