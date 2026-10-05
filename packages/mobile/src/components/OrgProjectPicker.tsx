/**
 * Shared org + project selector for mobile. Fetches `/api/orgs` and
 * `/api/projects?orgId=`, renders pill rows the user taps to pick. Replaces
 * typed-in `org_id` / `project_id` text inputs across brain screens.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { listOrgs, listProjects } from "../services/api";
import { colors, ORG_COLORS } from "../theme";
import type { OrgWithStats, Project } from "../types";

const ORG_LEVEL_PROJECT_ID = "_org_level";

interface Scope {
  orgId: string;
  projectId: string;
}

interface Props {
  scope: Scope;
  onChange: (next: Scope) => void;
  /** Show the `_org_level` sentinel as an option in the project list. */
  showOrgLevel?: boolean;
}

export function OrgProjectPicker({
  scope,
  onChange,
  showOrgLevel = true,
}: Props): React.JSX.Element {
  const [orgs, setOrgs] = useState<OrgWithStats[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showOrg, setShowOrg] = useState(false);
  const [showProject, setShowProject] = useState(false);

  // Stash onChange in a ref so the picker's effects don't re-run when the
  // parent passes a new inline callback (which it always does without
  // useCallback). Keeps the orgs/projects fetches stable.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // Refetch orgs every time the screen comes into focus so newly-created
  // orgs show up without an app restart.
  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      listOrgs()
        .then((rs) => {
          setOrgs(rs);
          if (!rs.find((o) => o.id === scope.orgId) && rs.length > 0) {
            onChangeRef.current({
              orgId: rs[0].id,
              projectId: ORG_LEVEL_PROJECT_ID,
            });
          }
        })
        .catch(() => {})
        .finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  useEffect(() => {
    if (!scope.orgId) return;
    listProjects({ orgId: scope.orgId })
      .then((ps) => {
        setProjects(ps);
        const exists =
          scope.projectId === ORG_LEVEL_PROJECT_ID ||
          ps.some((p) => p.id === scope.projectId);
        if (!exists && ps.length > 0) {
          onChangeRef.current({ orgId: scope.orgId, projectId: ps[0].id });
        }
      })
      .catch(() => setProjects([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.orgId]);

  const orgRow = orgs.find((o) => o.id === scope.orgId);
  const orgColor = orgRow
    ? ORG_COLORS[orgRow.id] ?? colors.primary
    : colors.cardBorder;
  const orgLabel = orgRow?.name ?? scope.orgId;

  const projectLabel =
    scope.projectId === ORG_LEVEL_PROJECT_ID
      ? "— org-level —"
      : (projects.find((p) => p.id === scope.projectId)?.name ?? scope.projectId);

  return (
    <View style={styles.row}>
      <TouchableOpacity
        style={[styles.pill, { borderColor: orgColor }]}
        onPress={() => setShowOrg(true)}
        activeOpacity={0.7}
      >
        <View style={[styles.dot, { backgroundColor: orgColor }]} />
        <Text style={styles.pillText} numberOfLines={1}>
          {loading ? "…" : orgLabel}
        </Text>
        <Text style={styles.chev}>▾</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.pill}
        onPress={() => setShowProject(true)}
        activeOpacity={0.7}
      >
        <Text style={styles.pillText} numberOfLines={1}>
          {projectLabel}
        </Text>
        <Text style={styles.chev}>▾</Text>
      </TouchableOpacity>

      <PickerSheet
        visible={showOrg}
        title="Select org"
        onClose={() => setShowOrg(false)}
      >
        {loading && <ActivityIndicator color={colors.primary} />}
        {orgs.map((o) => (
          <TouchableOpacity
            key={o.id}
            style={[
              styles.option,
              scope.orgId === o.id && styles.optionSelected,
            ]}
            onPress={() => {
              onChange({ orgId: o.id, projectId: ORG_LEVEL_PROJECT_ID });
              setShowOrg(false);
            }}
          >
            <View
              style={[
                styles.dot,
                { backgroundColor: ORG_COLORS[o.id] ?? colors.primary },
              ]}
            />
            <View style={{ flex: 1 }}>
              <Text style={styles.optionLabel}>{o.name}</Text>
              <Text style={styles.optionSub}>
                {o.projectCount} projects · {o.activeSessions} active
              </Text>
            </View>
            {scope.orgId === o.id && <Text style={styles.check}>✓</Text>}
          </TouchableOpacity>
        ))}
      </PickerSheet>

      <PickerSheet
        visible={showProject}
        title="Select project"
        onClose={() => setShowProject(false)}
      >
        {showOrgLevel && (
          <TouchableOpacity
            style={[
              styles.option,
              scope.projectId === ORG_LEVEL_PROJECT_ID && styles.optionSelected,
            ]}
            onPress={() => {
              onChange({ orgId: scope.orgId, projectId: ORG_LEVEL_PROJECT_ID });
              setShowProject(false);
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.optionLabel}>— org-level —</Text>
              <Text style={styles.optionSub}>spans every project in this org</Text>
            </View>
            {scope.projectId === ORG_LEVEL_PROJECT_ID && (
              <Text style={styles.check}>✓</Text>
            )}
          </TouchableOpacity>
        )}
        {projects.map((p) => (
          <TouchableOpacity
            key={p.id}
            style={[
              styles.option,
              scope.projectId === p.id && styles.optionSelected,
            ]}
            onPress={() => {
              onChange({ orgId: scope.orgId, projectId: p.id });
              setShowProject(false);
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.optionLabel}>{p.name}</Text>
              <Text style={styles.optionSub} numberOfLines={1}>
                {p.path}
              </Text>
            </View>
            {scope.projectId === p.id && <Text style={styles.check}>✓</Text>}
          </TouchableOpacity>
        ))}
        {projects.length === 0 && !loading && (
          <Text style={styles.empty}>no projects in this org yet</Text>
        )}
      </PickerSheet>
    </View>
  );
}

function PickerSheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{title}</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.sheetClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={{ maxHeight: 400 }}>{children}</ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.bg,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 6,
    minWidth: 0,
    flexShrink: 1,
  },
  pillText: {
    color: colors.textPrimary,
    fontSize: 13,
    maxWidth: 150,
  },
  chev: { color: colors.textMuted, fontSize: 11 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  sheet: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
  },
  sheetHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  sheetTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: "700" },
  sheetClose: { color: colors.textMuted, fontSize: 18, paddingHorizontal: 4 },
  option: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 12,
    borderRadius: 8,
    gap: 10,
  },
  optionSelected: { backgroundColor: "rgba(99,102,241,0.12)" },
  optionLabel: { color: colors.textPrimary, fontSize: 15, fontWeight: "500" },
  optionSub: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  check: { color: colors.primary, fontSize: 16 },
  empty: { color: colors.textMuted, fontSize: 13, padding: 12, textAlign: "center" },
});
