import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute } from "@react-navigation/native";
import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from "@react-navigation/native-stack";
import {
  fetchStrategyNodeDetail,
  updateStrategyNodeStatus,
  createStrategyNode,
} from "../services/api";
import { colors } from "../theme";
import { useRefresh } from "../hooks/useRefresh";
import * as Haptics from "expo-haptics";

interface NodeData {
  readonly id: string;
  readonly projectId: string;
  readonly orgId: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly progressPct: number;
  readonly computedProgressPct: number;
  readonly depth: number;
  readonly totalLeaves: number;
  readonly completedLeaves: number;
  readonly dependencies: readonly { readonly nodeId: string; readonly type: string }[];
  readonly assignedSessionId: string | null;
}

interface PathEntry {
  readonly id: string;
  readonly title: string;
}

type RootStackParamList = {
  Tabs: undefined;
  StrategyNode: { nodeId: string; title: string };
};

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

const DEP_TYPE_COLORS: Record<string, string> = {
  FS: colors.statusStarting,
  SS: "#f59e0b",
  FF: "#a855f7",
  SF: colors.danger,
};

export function StrategyNodeScreen(): React.JSX.Element {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<any>();
  const { nodeId } = route.params as { nodeId: string; title: string };

  const [node, setNode] = useState<NodeData | null>(null);
  const [children, setChildren] = useState<NodeData[]>([]);
  const [path, setPath] = useState<PathEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const data = await fetchStrategyNodeDetail(nodeId);
      setNode(data.node);
      setChildren(data.children);
      setPath(data.path);
    } catch {
      // Network error
    } finally {
      setLoading(false);
    }
  }, [nodeId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const { refreshing, handleRefresh } = useRefresh(loadData);

  const handleStatusChange = useCallback(
    async (status: string) => {
      try {
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        await updateStrategyNodeStatus(nodeId, status);
        await loadData();
      } catch {
        // Error
      }
    },
    [nodeId, loadData],
  );

  const handleAddChild = useCallback(() => {
    if (!node) return;
    Alert.prompt(
      "Add Child",
      "Enter a title for the new node:",
      async (title) => {
        if (!title?.trim()) return;
        try {
          await createStrategyNode({
            projectId: node.projectId,
            orgId: node.orgId,
            parentId: node.id,
            type: "task",
            title: title.trim(),
          });
          await loadData();
        } catch {
          // Error
        }
      },
    );
  }, [node, loadData]);

  const renderChild = useCallback(
    ({ item }: { item: NodeData }) => {
      const hasChildren = children.length > 0;
      return (
        <Pressable
          style={styles.childRow}
          onPress={() => {
            navigation.push("StrategyNode", {
              nodeId: item.id,
              title: item.title,
            });
          }}
        >
          <View
            style={[
              styles.statusDot,
              {
                backgroundColor:
                  STATUS_COLORS[item.status] ?? colors.textMuted,
              },
            ]}
          />
          <View
            style={[
              styles.typeBadge,
              {
                borderColor: TYPE_COLORS[item.type] ?? colors.textMuted,
              },
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
          <Text
            style={[
              styles.childTitle,
              item.status === "skipped" && styles.skippedTitle,
            ]}
            numberOfLines={1}
          >
            {item.title}
          </Text>
          <View style={styles.progressBarSmall}>
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
          <Text style={styles.chevron}>{"\u203A"}</Text>
        </Pressable>
      );
    },
    [navigation, children.length],
  );

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (!node) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.emptyText}>Node not found</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={[]}>
      <FlatList
        data={children}
        keyExtractor={(item) => item.id}
        renderItem={renderChild}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.textSecondary}
          />
        }
        ListHeaderComponent={
          <View style={styles.headerSection}>
            {/* Breadcrumb */}
            <View style={styles.breadcrumb}>
              {path.map((crumb, idx) => (
                <Pressable
                  key={crumb.id}
                  onPress={() => {
                    if (crumb.id !== nodeId) {
                      navigation.push("StrategyNode", {
                        nodeId: crumb.id,
                        title: crumb.title,
                      });
                    }
                  }}
                  style={styles.breadcrumbItem}
                >
                  {idx > 0 && (
                    <Text style={styles.breadcrumbSeparator}> &gt; </Text>
                  )}
                  <Text
                    style={[
                      styles.breadcrumbText,
                      crumb.id === nodeId && styles.breadcrumbActive,
                    ]}
                    numberOfLines={1}
                  >
                    {crumb.title}
                  </Text>
                </Pressable>
              ))}
            </View>

            {/* Node detail card */}
            <View style={styles.detailCard}>
              <View style={styles.detailHeader}>
                <View
                  style={[
                    styles.typeBadge,
                    {
                      borderColor: TYPE_COLORS[node.type] ?? colors.textMuted,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.typeBadgeText,
                      {
                        color: TYPE_COLORS[node.type] ?? colors.textMuted,
                      },
                    ]}
                  >
                    {node.type.toUpperCase()}
                  </Text>
                </View>
                <View
                  style={[
                    styles.statusDot,
                    {
                      backgroundColor:
                        STATUS_COLORS[node.status] ?? colors.textMuted,
                    },
                  ]}
                />
                <Text style={styles.statusText}>
                  {node.status.replace("_", " ")}
                </Text>
              </View>

              <Text style={styles.nodeTitle}>{node.title}</Text>

              {node.description ? (
                <Text style={styles.nodeDescription}>{node.description}</Text>
              ) : null}

              {/* Progress */}
              <View style={styles.progressSection}>
                <View style={styles.progressBar}>
                  <View
                    style={[
                      styles.progressBarFill,
                      {
                        width: `${Math.min(node.computedProgressPct, 100)}%`,
                        backgroundColor:
                          node.computedProgressPct >= 100
                            ? colors.statusCompleted
                            : colors.statusStarting,
                      },
                    ]}
                  />
                </View>
                <Text style={styles.progressText}>
                  {Math.round(node.computedProgressPct)}%
                </Text>
              </View>

              {/* Dependencies */}
              {node.dependencies.length > 0 && (
                <View style={styles.depsSection}>
                  <Text style={styles.sectionLabel}>Dependencies</Text>
                  <View style={styles.depsRow}>
                    {node.dependencies.map((dep) => (
                      <View
                        key={dep.nodeId}
                        style={[
                          styles.depBadge,
                          {
                            borderColor:
                              DEP_TYPE_COLORS[dep.type] ?? colors.textMuted,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.depBadgeText,
                            {
                              color:
                                DEP_TYPE_COLORS[dep.type] ?? colors.textMuted,
                            },
                          ]}
                        >
                          {dep.type}: {dep.nodeId.slice(0, 8)}
                        </Text>
                      </View>
                    ))}
                  </View>
                </View>
              )}
            </View>

            {/* Action buttons */}
            <View style={styles.actionButtons}>
              <Pressable
                style={[styles.actionBtn, { backgroundColor: colors.statusCompleted + "20" }]}
                onPress={() => handleStatusChange("completed")}
              >
                <Text style={[styles.actionBtnText, { color: colors.statusCompleted }]}>
                  Mark Complete
                </Text>
              </Pressable>
              <Pressable
                style={[styles.actionBtn, { backgroundColor: colors.statusStarting + "20" }]}
                onPress={() => handleStatusChange("in_progress")}
              >
                <Text style={[styles.actionBtnText, { color: colors.statusStarting }]}>
                  In Progress
                </Text>
              </Pressable>
              <Pressable
                style={[styles.actionBtn, { backgroundColor: colors.danger + "20" }]}
                onPress={() => handleStatusChange("blocked")}
              >
                <Text style={[styles.actionBtnText, { color: colors.danger }]}>
                  Blocked
                </Text>
              </Pressable>
            </View>

            {/* Children section header */}
            <View style={styles.childrenHeader}>
              <Text style={styles.sectionLabel}>
                Children ({children.length})
              </Text>
              <Pressable onPress={handleAddChild}>
                <Text style={styles.addChildText}>+ Add Child</Text>
              </Pressable>
            </View>
          </View>
        }
        ListEmptyComponent={
          <View style={styles.emptyChildren}>
            <Text style={styles.emptyText}>
              No children. This is a leaf node.
            </Text>
          </View>
        }
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
  loadingContainer: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  headerSection: {
    paddingBottom: 8,
  },
  breadcrumb: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  breadcrumbItem: {
    flexDirection: "row",
    alignItems: "center",
  },
  breadcrumbSeparator: {
    fontSize: 11,
    color: colors.textMuted,
  },
  breadcrumbText: {
    fontSize: 11,
    color: colors.textMuted,
  },
  breadcrumbActive: {
    color: colors.textSecondary,
    fontWeight: "600",
  },
  detailCard: {
    marginHorizontal: 16,
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 16,
  },
  detailHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  typeBadge: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  typeBadgeText: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 12,
    color: colors.textSecondary,
    textTransform: "capitalize",
  },
  nodeTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.textPrimary,
    marginBottom: 4,
  },
  nodeDescription: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18,
    marginBottom: 8,
  },
  progressSection: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  progressBar: {
    flex: 1,
    height: 6,
    backgroundColor: colors.surface,
    borderRadius: 3,
  },
  progressBarSmall: {
    width: 40,
    height: 4,
    backgroundColor: colors.surface,
    borderRadius: 2,
  },
  progressBarFill: {
    height: "100%",
    borderRadius: 3,
  },
  progressText: {
    fontSize: 12,
    color: colors.textSecondary,
    fontWeight: "600",
    width: 36,
    textAlign: "right",
  },
  depsSection: {
    marginTop: 12,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  depsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  depBadge: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  depBadgeText: {
    fontSize: 10,
    fontWeight: "600",
  },
  actionButtons: {
    flexDirection: "row",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 12,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
  },
  actionBtnText: {
    fontSize: 12,
    fontWeight: "600",
  },
  childrenHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 8,
  },
  addChildText: {
    fontSize: 13,
    color: colors.primary,
    fontWeight: "600",
  },
  childRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder + "40",
    gap: 8,
  },
  childTitle: {
    flex: 1,
    fontSize: 14,
    color: colors.textPrimary,
    fontWeight: "500",
  },
  skippedTitle: {
    color: colors.textMuted,
    textDecorationLine: "line-through",
  },
  chevron: {
    fontSize: 18,
    color: colors.textMuted,
    marginLeft: 4,
  },
  emptyChildren: {
    alignItems: "center",
    paddingVertical: 24,
  },
  emptyText: {
    fontSize: 13,
    color: colors.textMuted,
  },
  listContent: {
    paddingBottom: 40,
  },
});
