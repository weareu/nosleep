import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { StatusDot } from "./StatusDot";
import { colors } from "../theme";
import { formatTokens, elapsedTime, statusLabel } from "../utils";
import type { SessionWithProject } from "../types";

interface SessionCardProps {
  readonly session: SessionWithProject;
  readonly onPress: () => void;
  readonly orgColor: string;
}

export function SessionCard({
  session,
  onPress,
  orgColor,
}: SessionCardProps): React.JSX.Element {
  const progressPct = session.goal?.progressPct ?? 0;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { borderLeftColor: orgColor },
        pressed && styles.cardPressed,
      ]}
    >
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <StatusDot status={session.status} />
          <Text style={styles.projectName} numberOfLines={1}>
            {session.projectName ?? session.projectId}
          </Text>
        </View>
        <Text style={styles.statusLabel}>{statusLabel(session.status)}</Text>
      </View>

      <Text style={styles.goalText} numberOfLines={1}>
        {session.goalText}
      </Text>

      {/* Progress bar */}
      <View style={styles.progressContainer}>
        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              {
                width: `${Math.min(progressPct, 100)}%`,
                backgroundColor: orgColor,
              },
            ]}
          />
        </View>
        <Text style={styles.progressText}>{progressPct}%</Text>
      </View>

      {/* Stats row */}
      <View style={styles.statsRow}>
        <Text style={styles.stat}>
          {formatTokens(session.tokensUsed)} tokens
        </Text>
        <Text style={styles.stat}>{elapsedTime(session.startedAt)}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 10,
    borderLeftWidth: 3,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  cardPressed: {
    opacity: 0.7,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
  },
  projectName: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.textPrimary,
    marginLeft: 6,
    flex: 1,
  },
  statusLabel: {
    fontSize: 12,
    fontWeight: "500",
    color: colors.textSecondary,
  },
  goalText: {
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: 10,
    marginLeft: 30,
  },
  progressContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },
  progressTrack: {
    flex: 1,
    height: 4,
    backgroundColor: colors.surface,
    borderRadius: 2,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 2,
  },
  progressText: {
    fontSize: 11,
    color: colors.textMuted,
    marginLeft: 8,
    width: 32,
    textAlign: "right",
  },
  statsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginLeft: 30,
  },
  stat: {
    fontSize: 12,
    color: colors.textMuted,
  },
});
