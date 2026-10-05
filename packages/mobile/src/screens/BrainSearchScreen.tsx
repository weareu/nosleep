/**
 * Mobile brain search tab — hybrid lexical+semantic search across the brain.
 * Results merge archive artifacts and distilled thoughts; tap a hit to open
 * the artifact or thought view.
 */

import React, { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  brainSearch,
  type BrainSearchResult,
} from "../services/brainApi";
import { colors } from "../theme";
import { OrgProjectPicker } from "../components/OrgProjectPicker";
import { FAB_CONTENT_INSET } from "../components/GlobalMicFab";
import type { RootStackParamList } from "../navigation/RootNavigator";

const DEFAULT_ORG = "org_personal";
const DEFAULT_PROJECT = "_org_level";

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

export function BrainSearchScreen(): React.JSX.Element {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [orgId, setOrgId] = useState(DEFAULT_ORG);
  const [projectId, setProjectId] = useState(DEFAULT_PROJECT);
  const [query, setQuery] = useState("");
  const [allTime, setAllTime] = useState(false);
  const [items, setItems] = useState<BrainSearchResult[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const [filesQueried, setFilesQueried] = useState<string[] | undefined>();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function runSearch() {
    if (!query.trim()) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await brainSearch({
        org_id: orgId,
        project_id: projectId,
        // Scope to the selected project; only search org-wide when the
        // picker is on the org-level catch-all.
        scope: projectId && projectId !== DEFAULT_PROJECT ? "project" : "org",
        text: { query: query.trim(), mode: "hybrid" },
        limit: 30,
        time_range: allTime ? "all_time" : "recent",
      });
      setItems(r.results);
      setLatency(r.latency_ms);
      setFilesQueried(r.files_queried);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.root}
    >
      <View style={styles.headerCard}>
        <Text style={styles.title}>Brain Search</Text>

        <OrgProjectPicker
          scope={{ orgId, projectId }}
          onChange={(s) => {
            setOrgId(s.orgId);
            setProjectId(s.projectId);
          }}
        />

        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="search the brain…"
          placeholderTextColor={colors.textMuted}
          style={[styles.input, { marginTop: 8 }]}
          onSubmitEditing={runSearch}
          returnKeyType="search"
        />

        <View style={[styles.row, { marginTop: 8, alignItems: "center" }]}>
          <View style={[styles.row, { flex: 1, alignItems: "center" }]}>
            <Switch
              value={allTime}
              onValueChange={setAllTime}
              trackColor={{ false: colors.cardBorder, true: colors.primary }}
            />
            <Text style={styles.switchLabel}>fan-out (sealed)</Text>
          </View>
          <TouchableOpacity
            style={styles.searchBtn}
            onPress={runSearch}
            disabled={loading || !query.trim()}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.searchBtnText}>Search</Text>
            )}
          </TouchableOpacity>
        </View>

        {(latency !== null || filesQueried) && (
          <Text style={styles.metaLine}>
            {items.length} results
            {latency !== null ? ` · ${Math.round(latency)} ms` : ""}
            {filesQueried && filesQueried.length > 1
              ? ` · ${filesQueried.length} files`
              : ""}
          </Text>
        )}
      </View>

      {err && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{err}</Text>
        </View>
      )}

      <FlatList
        data={items}
        keyExtractor={(r) => r.hash}
        contentContainerStyle={{ padding: 12, gap: 8, paddingBottom: FAB_CONTENT_INSET }}
        ListEmptyComponent={
          !loading && !err ? (
            <Text style={styles.empty}>
              {query
                ? "no results"
                : "type a query and search the brain"}
            </Text>
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable
            style={[styles.resultCard, item.layer === "thoughts" && styles.thoughtCard]}
            accessibilityRole="button"
            accessibilityLabel={item.layer === "thoughts" ? "Open thought" : "Open artifact"}
            onPress={() =>
              item.layer === "thoughts"
                ? navigation.navigate("BrainThought", { id: item.hash, orgId })
                : navigation.navigate("BrainArtifact", { hash: item.hash, orgId })
            }
          >
            <View style={styles.resultHeader}>
              {item.layer === "thoughts" ? (
                <Text style={styles.thoughtBadge}>
                  thought · {item.thought?.thought_type ?? "observation"}
                </Text>
              ) : (
                <Text style={styles.resultKind}>{item.kind}</Text>
              )}
              <Text style={styles.resultTs}>{fmtDate(item.ts)}</Text>
            </View>
            <Text numberOfLines={3} style={styles.resultSnippet}>
              {item.snippet || "[no snippet]"}
            </Text>
            <Text style={styles.resultMeta}>
              score {item.score.toFixed(3)} · rank #{item.fused_rank}
              {item.session_id ? ` · session ${item.session_id.slice(0, 8)}` : ""}
            </Text>
          </Pressable>
        )}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  headerCard: {
    backgroundColor: colors.card,
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 20,
    fontWeight: "700",
    marginBottom: 8,
  },
  row: { flexDirection: "row" },
  flex1: { flex: 1 },
  input: {
    backgroundColor: colors.bg,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.textPrimary,
    fontSize: 14,
  },
  switchLabel: { color: colors.textSecondary, marginLeft: 8, fontSize: 13 },
  searchBtn: {
    backgroundColor: colors.primary,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 8,
  },
  searchBtnText: { color: "#fff", fontWeight: "600" },
  metaLine: { color: colors.textMuted, fontSize: 12, marginTop: 8 },
  errorBox: {
    backgroundColor: "rgba(239,68,68,0.15)",
    borderColor: colors.danger,
    borderWidth: 1,
    margin: 12,
    padding: 8,
    borderRadius: 6,
  },
  errorText: { color: colors.danger, fontSize: 13 },
  empty: {
    color: colors.textMuted,
    textAlign: "center",
    marginTop: 30,
    fontSize: 14,
  },
  resultCard: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
  },
  thoughtCard: { borderColor: "rgba(139,92,246,0.5)" },
  thoughtBadge: { color: "#c4b5fd", fontSize: 12, fontWeight: "600" },
  resultHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  resultKind: {
    color: colors.textSecondary,
    fontSize: 12,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  resultTs: { color: colors.textMuted, fontSize: 11 },
  resultSnippet: { color: colors.textPrimary, fontSize: 14, lineHeight: 20 },
  resultMeta: { color: colors.textMuted, fontSize: 11, marginTop: 6 },
});
