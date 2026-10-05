/**
 * Mobile thought detail — the destination for thought hits in Brain Search.
 * Shows the distilled content plus extracted metadata (type, topics, people,
 * action items).
 */

import React, { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";
import { getThought, type BrainThought } from "../services/brainApi";

export interface BrainThoughtScreenProps {
  route: { params: { id: string; orgId: string } };
}

type ThoughtDetail = BrainThought & { project_id: string; visibility: string };

export function BrainThoughtScreen(props: BrainThoughtScreenProps): React.JSX.Element {
  const { id, orgId } = props.route.params;
  const [thought, setThought] = useState<ThoughtDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getThought(id, orgId)
      .then((t) => {
        if (!cancelled) setThought(t);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, orgId]);

  const type = thought?.thought_type ?? thought?.metadata.type ?? "observation";

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      {err && <Text style={styles.err}>{err}</Text>}
      {loading ? (
        <ActivityIndicator color={colors.textPrimary} style={styles.loader} />
      ) : thought ? (
        <View>
          <View style={styles.badgeRow}>
            <Text style={styles.badge}>{type}</Text>
            {thought.visibility !== "active" && (
              <Text style={[styles.badge, styles.badgeMuted]}>{thought.visibility}</Text>
            )}
          </View>
          <Text style={styles.body} selectable>
            {thought.content}
          </Text>
          <View style={styles.metaCard}>
            <Row label="created" value={new Date(thought.created_at * 1000).toLocaleString()} />
            <Row label="project" value={thought.project_id} />
            <Row label="source" value={thought.source_kind} />
            {thought.metadata.topics.length > 0 && (
              <Row label="topics" value={thought.metadata.topics.join(", ")} />
            )}
            {thought.metadata.people.length > 0 && (
              <Row label="people" value={thought.metadata.people.join(", ")} />
            )}
          </View>
          {thought.metadata.action_items.length > 0 && (
            <View style={styles.metaCard}>
              <Text style={styles.sectionLabel}>action items</Text>
              {thought.metadata.action_items.map((a) => (
                <Text key={a} style={styles.item}>
                  • {a}
                </Text>
              ))}
            </View>
          )}
          <Text style={styles.id} selectable>
            {thought.id}
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 48 },
  loader: { marginTop: 32 },
  err: {
    color: colors.danger,
    padding: 10,
    backgroundColor: "rgba(220,38,38,0.08)",
    borderRadius: 8,
    marginBottom: 12,
  },
  badgeRow: { flexDirection: "row", gap: 6, marginBottom: 10 },
  badge: {
    color: "#c4b5fd",
    backgroundColor: "rgba(139,92,246,0.15)",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    fontSize: 12,
    overflow: "hidden",
  },
  badgeMuted: { color: colors.textMuted, backgroundColor: colors.card },
  body: { color: colors.textPrimary, fontSize: 16, lineHeight: 24, marginBottom: 16 },
  metaCard: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
  },
  row: { flexDirection: "row", paddingVertical: 4 },
  rowLabel: {
    width: 90,
    color: colors.textMuted,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  rowValue: { color: colors.textPrimary, fontSize: 13, flex: 1 },
  sectionLabel: {
    color: colors.textMuted,
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 6,
  },
  item: { color: colors.textPrimary, fontSize: 13, lineHeight: 20 },
  id: { color: colors.textMuted, fontSize: 10, fontFamily: "Menlo" },
});
