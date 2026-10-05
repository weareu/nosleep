import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { listProjects, listOrgs, fetchStrategyTree } from "../services/api";
import { colors, getOrgColor } from "../theme";
import { useRefresh } from "../hooks/useRefresh";
import type { OrgWithStats, Project } from "../types";

interface StrategyNodeRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly title: string;
  readonly status: string;
  readonly computedProgressPct: number;
  readonly depth: number;
  readonly totalLeaves: number;
  readonly completedLeaves: number;
  readonly hasChildren: boolean;
}

interface TreeSummary {
  readonly totalNodes: number;
  readonly totalLeaves: number;
  readonly completedLeaves: number;
  readonly overallProgressPct: number;
}

const STATUS_COLORS: Record<string, string> = {
  pending: colors.textMuted,
  in_progress: colors.statusStarting,
  completed: colors.statusCompleted,
  blocked: colors.danger,
  skipped: colors.textMuted,
};

const TYPE_COLORS: Record<string, string> = {
  strategy: "#a855f7",
  goal: colors.statusStarting,
  task: "#f59e0b",
  subtask: colors.textMuted,
};

type RootStackParamList = {
  Tabs: undefined;
  StrategyNode: { nodeId: string; title: string };
};

export function StrategyScreen(): React.JSX.Element {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [orgs, setOrgs] = useState<OrgWithStats[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<StrategyNodeRow[]>([]);
  const [treeSummary, setTreeSummary] = useState<TreeSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [showProjectPicker, setShowProjectPicker] = useState(false);

  const loadProjects = useCallback(async () => {
    try {
      const [orgsData, projectsData] = await Promise.all([
        listOrgs(),
        listProjects(),
      ]);
      setOrgs(orgsData);
      setProjects(projectsData);
    } catch {
      // Network error
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const loadTree = useCallback(async () => {
    if (!selectedProjectId) return;
    setLoading(true);
    try {
      const tree = await fetchStrategyTree(selectedProjectId);
      if (tree) {
        // Build flat list of root-level nodes only (for drill-down pattern)
        const rootNodes = tree.nodes
          .filter((n: StrategyNodeRow) => n.parentId === null || !tree.nodes.some((p: StrategyNodeRow) => p.id === n.parentId && p.parentId === null && n.parentId !== null) && n.depth === 0)
          .filter((n: StrategyNodeRow) => n.parentId === null)
          .map((n: any) => ({
            id: n.id,
            parentId: n.parentId,
            type: n.type,
            title: n.title,
            status: n.status,
            computedProgressPct: n.computedProgressPct,
            depth: 0,
            totalLeaves: n.totalLeaves,
            completedLeaves: n.completedLeaves,
            hasChildren: tree.nodes.some((c: any) => c.parentId === n.id),
          }));
        setNodes(rootNodes);
        setTreeSummary({
          totalNodes: tree.totalNodes,
          totalLeaves: tree.totalLeaves,
          completedLeaves: tree.completedLeaves,
          overallProgressPct: tree.overallProgressPct,
        });
      } else {
        setNodes([]);
        setTreeSummary(null);
      }
    } catch {
      setNodes([]);
      setTreeSummary(null);
    } finally {
      setLoading(false);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    if (selectedProjectId) {
      loadTree();
    }
  }, [selectedProjectId, loadTree]);

  const { refreshing, handleRefresh } = useRefresh(loadTree);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId),
    [projects, selectedProjectId],
  );

  const renderNode = useCallback(
    ({ item }: { item: StrategyNodeRow }) => (
      <Pressable
        style={styles.nodeRow}
        onPress={() => {
          navigation.navigate("StrategyNode", {
            nodeId: item.id,
            title: item.title,
          });
        }}
      >
        {/* Status dot */}
        <View
          style={[
            styles.statusDot,
            { backgroundColor: STATUS_COLORS[item.status] ?? colors.textMuted },
          ]}
        />

        {/* Type badge */}
        <View
          style={[
            styles.typeBadge,
            { borderColor: TYPE_COLORS[item.type] ?? colors.textMuted },
          ]}
        >
          <Text
            style={[
              styles.typeBadgeText,
              { color: TYPE_COLORS[item.type] ?? colors.textMuted },
            ]}
          >
            {item.type.toUpperCase()}
          </Text>
        </View>

        {/* Title */}
        <Text
          style={[
            styles.nodeTitle,
            item.status === "skipped" && styles.skippedTitle,
          ]}
          numberOfLines={1}
        >
          {item.title}
        </Text>

        {/* Progress bar */}
        <View style={styles.progressBarContainer}>
          <View
            style={[
              styles.progressBarFill,
              {
                width: `${Math.min(item.computedProgressPct, 100)}%`,
                backgroundColor:
                  item.computedProgressPct >= 100
                    ? colors.statusCompleted
                    : colors.statusStarting,
              },
            ]}
          />
        </View>

        {/* Chevron if has children */}
        {item.hasChildren && (
          <Text style={styles.chevron}>{"\u203A"}</Text>
        )}
      </Pressable>
    ),
    [navigation],
  );

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Strategy</Text>
      </View>

      {/* Project picker */}
      <Pressable
        style={styles.projectPicker}
        onPress={() => setShowProjectPicker(!showProjectPicker)}
      >
        <Text style={styles.projectPickerText}>
          {selectedProject
            ? selectedProject.name
            : "Select a project..."}
        </Text>
        <Text style={styles.projectPickerChevron}>
          {showProjectPicker ? "\u25B2" : "\u25BC"}
        </Text>
      </Pressable>

      {showProjectPicker && (
        <View style={styles.projectList}>
          {orgs.map((org) => {
            const orgProjects = projects.filter(
              (p) => p.orgId === org.id,
            );
            if (orgProjects.length === 0) return null;
            return (
              <View key={org.id}>
                <Text
                  style={[
                    styles.orgLabel,
                    { color: getOrgColor(org.id) },
                  ]}
                >
                  {org.name}
                </Text>
                {orgProjects.map((p) => (
                  <Pressable
                    key={p.id}
                    style={[
                      styles.projectOption,
                      p.id === selectedProjectId && styles.projectOptionSelected,
                    ]}
                    onPress={() => {
                      setSelectedProjectId(p.id);
                      setShowProjectPicker(false);
                    }}
                  >
                    <Text style={styles.projectOptionText}>{p.name}</Text>
                  </Pressable>
                ))}
              </View>
            );
          })}
        </View>
      )}

      {/* Tree summary */}
      {treeSummary && (
        <View style={styles.summary}>
          <View style={styles.summaryProgressContainer}>
            <View
              style={[
                styles.summaryProgressFill,
                {
                  width: `${Math.min(treeSummary.overallProgressPct, 100)}%`,
                },
              ]}
            />
          </View>
          <Text style={styles.summaryText}>
            {Math.round(treeSummary.overallProgressPct)}% complete
            {" \u2022 "}
            {treeSummary.completedLeaves}/{treeSummary.totalLeaves} leaves done
          </Text>
        </View>
      )}

      {/* Tree list */}
      {loading ? (
        <ActivityIndicator
          style={styles.loading}
          color={colors.primary}
          size="large"
        />
      ) : !selectedProjectId ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>
            Select a project to view its strategy tree
          </Text>
        </View>
      ) : (
        <FlatList
          data={nodes}
          keyExtractor={(item) => item.id}
          renderItem={renderNode}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={colors.textSecondary}
            />
          }
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>
                No strategy tree found for this project
              </Text>
            </View>
          }
        />
      )}
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
  projectPicker: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  projectPickerText: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  projectPickerChevron: {
    fontSize: 10,
    color: colors.textMuted,
  },
  projectList: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    paddingVertical: 8,
  },
  orgLabel: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 4,
  },
  projectOption: {
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  projectOptionSelected: {
    backgroundColor: colors.surface,
  },
  projectOptionText: {
    fontSize: 14,
    color: colors.textPrimary,
  },
  summary: {
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 12,
  },
  summaryProgressContainer: {
    height: 4,
    backgroundColor: colors.surface,
    borderRadius: 2,
    marginBottom: 6,
  },
  summaryProgressFill: {
    height: "100%",
    backgroundColor: colors.statusStarting,
    borderRadius: 2,
  },
  summaryText: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  nodeRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder + "40",
    gap: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  typeBadge: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  typeBadgeText: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  nodeTitle: {
    flex: 1,
    fontSize: 14,
    color: colors.textPrimary,
    fontWeight: "500",
  },
  skippedTitle: {
    color: colors.textMuted,
    textDecorationLine: "line-through",
  },
  progressBarContainer: {
    width: 48,
    height: 4,
    backgroundColor: colors.surface,
    borderRadius: 2,
  },
  progressBarFill: {
    height: "100%",
    borderRadius: 2,
  },
  chevron: {
    fontSize: 18,
    color: colors.textMuted,
    marginLeft: 4,
  },
  loading: {
    marginTop: 40,
  },
  emptyContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 40,
  },
  emptyText: {
    fontSize: 14,
    color: colors.textMuted,
  },
  listContent: {
    paddingBottom: 20,
  },
});
