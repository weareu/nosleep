/**
 * Mobile artifact detail. Kind-aware mini-renderer: text artifacts show
 * full content (mono for code/process), images show a placeholder, others
 * fall back to a JSON preview of kind_specific_meta.
 */

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { colors } from "../theme";
import { getArtifact, type BrainArtifact } from "../services/brainApi";

export interface BrainArtifactScreenProps {
  route: {
    params: {
      hash: string;
      orgId: string;
    };
  };
  navigation: {
    navigate: (screen: string, params?: Record<string, unknown>) => void;
  };
}

export function BrainArtifactScreen(
  props: BrainArtifactScreenProps,
): React.JSX.Element {
  const { hash, orgId } = props.route.params;
  const [artifact, setArtifact] = useState<BrainArtifact | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getArtifact(hash, orgId)
      .then((a) => {
        if (!cancelled) setArtifact(a);
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
  }, [hash, orgId]);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.header}>Artifact</Text>
      <Text style={styles.subheader} selectable>
        {hash}
      </Text>

      {err && <Text style={styles.err}>{err}</Text>}
      {loading ? (
        <ActivityIndicator color={colors.textPrimary} style={styles.loader} />
      ) : artifact ? (
        <View>
          <View style={styles.metaCard}>
            <Row label="kind" value={artifact.kind} mono />
            <Row label="ts" value={new Date(artifact.ts * 1000).toLocaleString()} />
            <Row label="project" value={artifact.project_id} />
            {artifact.session_id && (
              <TouchableOpacity
                onPress={() =>
                  props.navigation.navigate("BrainSession", {
                    sessionId: artifact.session_id,
                    orgId,
                  })
                }
              >
                <Row
                  label="session"
                  value={artifact.session_id}
                  highlight
                />
              </TouchableOpacity>
            )}
            <Row
              label="origin"
              value={`${artifact.origin.tool} / ${artifact.origin.actor ?? "—"}`}
            />
            <Row label="size" value={`${artifact.size}b`} />
            <Row label="content_type" value={artifact.content_type ?? "—"} />
          </View>

          {artifact.content_encoding === "base64" &&
          artifact.content_type?.startsWith("image/") ? (
            <Image
              source={{
                uri: `data:${artifact.content_type};base64,${artifact.content}`,
              }}
              style={styles.image}
              resizeMode="contain"
            />
          ) : artifact.content ? (
            <View style={styles.contentBlock}>
              <Text style={styles.contentLabel}>content</Text>
              <ScrollView horizontal>
                <Text style={isMonoKind(artifact.kind) ? styles.contentMono : styles.content_}>
                  {artifact.content}
                </Text>
              </ScrollView>
            </View>
          ) : null}

          <View style={styles.contentBlock}>
            <Text style={styles.contentLabel}>kind_specific_meta</Text>
            <Text style={styles.contentMono}>
              {JSON.stringify(artifact.kind_specific_meta, null, 2)}
            </Text>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

function isMonoKind(kind: string): boolean {
  return (
    kind.startsWith("code/") ||
    kind.startsWith("process/") ||
    kind === "data/json" ||
    kind === "data/yaml"
  );
}

function Row({
  label,
  value,
  mono,
  highlight,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text
        style={[
          styles.rowValue,
          mono && styles.rowMono,
          highlight && styles.rowHighlight,
        ]}
      >
        {value}
      </Text>
    </View>
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
    fontSize: 10,
    marginBottom: 16,
    fontFamily: "Menlo",
  },
  loader: {
    marginTop: 32,
  },
  err: {
    color: "#f87171",
    padding: 10,
    backgroundColor: "rgba(220,38,38,0.08)",
    borderRadius: 8,
    marginBottom: 12,
  },
  metaCard: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
  },
  row: {
    flexDirection: "row",
    paddingVertical: 4,
  },
  rowLabel: {
    width: 100,
    color: colors.textMuted,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  rowValue: {
    color: colors.textPrimary,
    fontSize: 13,
    flex: 1,
  },
  rowMono: {
    fontFamily: "Menlo",
    fontSize: 11,
  },
  rowHighlight: {
    color: "#60a5fa",
  },
  image: {
    width: "100%",
    height: 320,
    backgroundColor: "#000",
    borderRadius: 8,
    marginBottom: 16,
  },
  contentBlock: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
  },
  contentLabel: {
    color: colors.textMuted,
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 6,
  },
  content_: {
    color: colors.textPrimary,
    fontSize: 13,
    lineHeight: 18,
  },
  contentMono: {
    color: colors.textPrimary,
    fontSize: 11,
    fontFamily: "Menlo",
  },
});
