/**
 * Modal picker for choosing the parent of a strategy-tree note. Shows
 * the project's tree as a flat, indented list. Tap a node to select it
 * (or "(root)" at the top to attach with no parent). Default selection
 * is whichever node the picker is opened with — typically the project's
 * next-actionable node.
 */

import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { fetchStrategyTree } from "../services/api";
import { colors } from "../theme";

interface TreeNode {
  id: string;
  parentId: string | null;
  type: string;
  title: string;
  status: string;
  computedProgressPct?: number;
}

interface FlatRow {
  id: string;
  parentId: string | null;
  type: string;
  title: string;
  status: string;
  depth: number;
}

function flatten(nodes: TreeNode[]): FlatRow[] {
  // Build a parent → children map for depth-first traversal.
  const childrenOf = new Map<string | null, TreeNode[]>();
  for (const n of nodes) {
    const arr = childrenOf.get(n.parentId) ?? [];
    arr.push(n);
    childrenOf.set(n.parentId, arr);
  }
  const out: FlatRow[] = [];
  function walk(parentId: string | null, depth: number): void {
    const kids = childrenOf.get(parentId) ?? [];
    for (const k of kids) {
      out.push({
        id: k.id,
        parentId: k.parentId,
        type: k.type,
        title: k.title,
        status: k.status,
        depth,
      });
      walk(k.id, depth + 1);
    }
  }
  walk(null, 0);
  return out;
}

const STATUS_COLOR: Record<string, string> = {
  in_progress: "#facc15",
  blocked: "#f87171",
  done: "#34d399",
  pending: "#94a3b8",
};

export interface StrategyParentPickerProps {
  visible: boolean;
  projectId: string;
  selectedId: string | null;
  onCancel(): void;
  /** `id` is null for root. `title` is null for root, otherwise the node title. */
  onSelect(parentId: string | null, title: string | null): void;
}

export function StrategyParentPicker({
  visible,
  projectId,
  selectedId,
  onCancel,
  onSelect,
}: StrategyParentPickerProps): React.JSX.Element {
  const [rows, setRows] = useState<FlatRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setRows(null);
    setError(null);
    fetchStrategyTree(projectId)
      .then((tree) => {
        const nodes =
          (tree as { nodes?: TreeNode[] } | null)?.nodes ?? [];
        setRows(flatten(nodes));
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setRows([]);
      });
  }, [visible, projectId]);

  const data = useMemo<FlatRow[]>(() => {
    return [
      // Synthetic "root" entry — selecting it means parentId=null.
      {
        id: "__root__",
        parentId: null,
        type: "root",
        title: "(no parent — attach at root)",
        status: "",
        depth: 0,
      },
      ...(rows ?? []),
    ];
  }, [rows]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onCancel}
    >
      <View style={styles.root}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onCancel}>
            <Text style={styles.cancel}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Pick strategy parent</Text>
          <View style={{ width: 60 }} />
        </View>

        {rows === null && !error && (
          <View style={styles.center}>
            <ActivityIndicator color="#3b82f6" />
            <Text style={styles.dim}>Loading tree…</Text>
          </View>
        )}
        {error && <Text style={styles.error}>{error}</Text>}
        {rows !== null && (
          <FlatList
            data={data}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => {
              const isRoot = item.id === "__root__";
              const isSelected =
                (isRoot && selectedId === null) || item.id === selectedId;
              return (
                <Pressable
                  onPress={() =>
                    onSelect(
                      isRoot ? null : item.id,
                      isRoot ? null : item.title,
                    )
                  }
                  style={[
                    styles.row,
                    isSelected && styles.rowSelected,
                    { paddingLeft: 12 + item.depth * 16 },
                  ]}
                >
                  {!isRoot && (
                    <View
                      style={[
                        styles.statusDot,
                        {
                          backgroundColor:
                            STATUS_COLOR[item.status] ?? colors.textMuted,
                        },
                      ]}
                    />
                  )}
                  <View style={{ flex: 1 }}>
                    <Text
                      style={[
                        styles.rowTitle,
                        isSelected && styles.rowTitleSelected,
                      ]}
                      numberOfLines={1}
                    >
                      {item.title}
                    </Text>
                    {!isRoot && (
                      <Text style={styles.rowMeta}>
                        {item.type} · {item.status}
                      </Text>
                    )}
                  </View>
                  {isSelected && <Text style={styles.check}>✓</Text>}
                </Pressable>
              );
            }}
            ListEmptyComponent={
              <Text style={styles.dim}>
                No strategy tree yet — picking "(root)" creates the first
                node.
              </Text>
            }
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    borderBottomColor: colors.cardBorder,
    borderBottomWidth: 1,
  },
  title: { color: colors.textPrimary, fontSize: 15, fontWeight: "600" },
  cancel: { color: "#3b82f6", fontSize: 14 },
  center: { padding: 32, alignItems: "center", gap: 12 },
  dim: { color: colors.textMuted, fontSize: 12, padding: 16 },
  error: { color: "#f87171", padding: 16 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingRight: 12,
    borderBottomColor: colors.cardBorder,
    borderBottomWidth: 0.5,
  },
  rowSelected: { backgroundColor: "rgba(59, 130, 246, 0.12)" },
  rowTitle: { color: colors.textPrimary, fontSize: 14 },
  rowTitleSelected: { color: "#93c5fd", fontWeight: "600" },
  rowMeta: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 10,
  },
  check: { color: "#3b82f6", fontSize: 18, marginLeft: 12 },
});
