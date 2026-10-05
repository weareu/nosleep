/**
 * Mobile session detail — chronological scroll of artifacts captured for a
 * session. Phase 5-finish minimum: lightweight, kind-aware mini-renderers
 * (turn snippet, code diff first lines, command output mono, image
 * thumbnail placeholder). Phase 9 adds proper image rendering + jump-to.
 */

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { colors } from "../theme";
import {
  getSessionArtifacts,
  type BrainSessionArtifactItem,
} from "../services/brainApi";

export interface BrainSessionScreenProps {
  route: {
    params: {
      sessionId: string;
      orgId: string;
    };
  };
  navigation: {
    navigate: (screen: string, params?: Record<string, unknown>) => void;
  };
}

export function BrainSessionScreen(
  props: BrainSessionScreenProps,
): React.JSX.Element {
  const { sessionId, orgId } = props.route.params;
  const [items, setItems] = useState<BrainSessionArtifactItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getSessionArtifacts(sessionId, orgId, { limit: 200, order: "asc" })
      .then((r) => {
        if (!cancelled) setItems(r.items);
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
  }, [sessionId, orgId]);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.header}>Session</Text>
      <Text style={styles.subheader} selectable>
        {sessionId}
      </Text>

      {err && <Text style={styles.err}>{err}</Text>}
      {loading ? (
        <ActivityIndicator color={colors.textPrimary} style={styles.loader} />
      ) : (
        items.map((item, i) => (
          <TouchableOpacity
            key={item.hash}
            style={styles.item}
            onPress={() =>
              props.navigation.navigate("BrainArtifact", {
                hash: item.hash,
                orgId,
              })
            }
          >
            <View style={styles.itemHeader}>
              <Text style={styles.itemKind}>{item.kind}</Text>
              <Text style={styles.itemTs}>
                {new Date(item.ts * 1000).toLocaleTimeString()}
              </Text>
            </View>
            <Text style={styles.itemSnippet} numberOfLines={3}>
              {item.snippet ??
                (item.kind.startsWith("media/image/")
                  ? "[image]"
                  : "(no preview)")}
            </Text>
            <Text style={styles.itemMeta}>
              turn {item.turn_ord ?? i + 1} · {item.size}b · {item.origin_tool}
            </Text>
          </TouchableOpacity>
        ))
      )}
      {!loading && !err && items.length === 0 && (
        <Text style={styles.empty}>no artifacts in this session</Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: 16,
    paddingBottom: 48,
  },
  header: {
    color: colors.textPrimary,
    fontSize: 22,
    fontWeight: "700",
  },
  subheader: {
    color: colors.textMuted,
    fontSize: 11,
    marginBottom: 16,
  },
  loader: {
    marginTop: 32,
  },
  err: {
    color: "#f87171",
    backgroundColor: "rgba(220,38,38,0.08)",
    padding: 10,
    borderRadius: 8,
    marginBottom: 12,
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 24,
    textAlign: "center",
  },
  item: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  itemHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  itemKind: {
    color: colors.textPrimary,
    fontSize: 11,
    fontFamily: "Menlo",
    backgroundColor: "rgba(96, 165, 250, 0.15)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  itemTs: {
    color: colors.textMuted,
    fontSize: 11,
  },
  itemSnippet: {
    color: colors.textPrimary,
    fontSize: 13,
    lineHeight: 18,
  },
  itemMeta: {
    marginTop: 4,
    color: colors.textMuted,
    fontSize: 10,
  },
});
