import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  StyleSheet,
  Alert as RNAlert,
  Modal,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { StatusDot } from "../components/StatusDot";
import { OrgBadge } from "../components/OrgBadge";
import {
  getSession,
  getSessionGoal,
  interveneSession,
  listAlerts,
} from "../services/api";
import { useWsEvent } from "../hooks/useWsEvent";
import { colors, getStatusColor } from "../theme";
import {
  formatTokens,
  elapsedTime,
  statusLabel,
  relativeTime,
  isActiveStatus,
} from "../utils";
import type { SessionWithProject, Goal, Alert } from "../types";

interface SessionScreenProps {
  readonly route: { params: { sessionId: string } };
}

export function SessionScreen({ route }: SessionScreenProps): React.JSX.Element {
  const { sessionId } = route.params;
  const [session, setSession] = useState<SessionWithProject | null>(null);
  const [goal, setGoal] = useState<Goal | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [redirectModalVisible, setRedirectModalVisible] = useState(false);
  const [redirectMessage, setRedirectMessage] = useState("");
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const [sessionData, goalData, alertData] = await Promise.all([
        getSession(sessionId),
        getSessionGoal(sessionId).catch(() => null),
        listAlerts({ unackedOnly: false }),
      ]);
      setSession(sessionData);
      setGoal(goalData);
      setAlerts(
        alertData.filter((a: Alert) => a.sessionId === sessionId).slice(0, 10)
      );
    } catch {
      // Keep existing data
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleWsUpdate = useCallback(() => {
    loadData();
  }, [loadData]);

  useWsEvent("session:update", handleWsUpdate);
  useWsEvent("alert:new", handleWsUpdate);
  useWsEvent("goal:progress", handleWsUpdate);

  const handleStop = useCallback(async () => {
    RNAlert.alert("Stop Session", "Are you sure you want to stop this session?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Stop",
        style: "destructive",
        onPress: async () => {
          await Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Warning
          );
          try {
            await interveneSession(sessionId, "stop");
            loadData();
          } catch {
            RNAlert.alert("Error", "Failed to stop session");
          }
        },
      },
    ]);
  }, [sessionId, loadData]);

  const handleRedirect = useCallback(async () => {
    if (!redirectMessage.trim()) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await interveneSession(sessionId, "redirect", redirectMessage.trim());
      setRedirectModalVisible(false);
      setRedirectMessage("");
      loadData();
    } catch {
      RNAlert.alert("Error", "Failed to redirect session");
    }
  }, [sessionId, redirectMessage, loadData]);

  if (loading || !session) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.loadingText}>Loading...</Text>
      </SafeAreaView>
    );
  }

  const isActive = isActiveStatus(session.status);

  return (
    <SafeAreaView style={styles.container} edges={["bottom"]}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Header */}
        <View style={styles.section}>
          <View style={styles.headerRow}>
            <StatusDot status={session.status} size={14} />
            <Text style={styles.sessionTitle}>
              {session.projectName ?? session.projectId}
            </Text>
          </View>
          {session.orgId && <OrgBadge orgId={session.orgId} size="medium" />}
          <Text
            style={[
              styles.statusBadge,
              { color: getStatusColor(session.status) },
            ]}
          >
            {statusLabel(session.status)}
          </Text>
        </View>

        {/* Goal */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Goal</Text>
          <Text style={styles.goalText}>{session.goalText}</Text>
        </View>

        {/* Acceptance Criteria */}
        {goal && goal.acceptanceCriteria.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Acceptance Criteria</Text>
            {goal.acceptanceCriteria.map((criterion, index) => (
              <View key={index} style={styles.criterionRow}>
                <Text style={styles.criterionCheck}>
                  {criterion.met ? "\u2705" : "\u2B1C"}
                </Text>
                <Text
                  style={[
                    styles.criterionText,
                    criterion.met && styles.criterionMet,
                  ]}
                >
                  {criterion.description}
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* Stats */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Stats</Text>
          <View style={styles.statsGrid}>
            <View style={styles.statBox}>
              <Text style={styles.statValue}>
                {formatTokens(session.tokensUsed)}
              </Text>
              <Text style={styles.statLabel}>Tokens</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statValue}>
                {elapsedTime(session.startedAt)}
              </Text>
              <Text style={styles.statLabel}>Elapsed</Text>
            </View>
            {goal && (
              <View style={styles.statBox}>
                <Text style={styles.statValue}>{goal.progressPct}%</Text>
                <Text style={styles.statLabel}>Progress</Text>
              </View>
            )}
          </View>
        </View>

        {/* Progress bar */}
        {goal && (
          <View style={styles.section}>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.min(goal.progressPct, 100)}%` },
                ]}
              />
            </View>
            {goal.currentPhase && (
              <Text style={styles.phaseText}>Phase: {goal.currentPhase}</Text>
            )}
          </View>
        )}

        {/* Actions */}
        {isActive && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Actions</Text>
            <View style={styles.actionRow}>
              <Pressable
                style={[styles.actionButton, styles.stopButton]}
                onPress={handleStop}
              >
                <Text style={styles.actionButtonText}>Stop</Text>
              </Pressable>
              <Pressable
                style={[styles.actionButton, styles.redirectButton]}
                onPress={() => setRedirectModalVisible(true)}
              >
                <Text style={styles.actionButtonText}>Redirect</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* Recent Alerts */}
        {alerts.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Recent Alerts</Text>
            {alerts.map((alert) => (
              <View key={alert.id} style={styles.alertRow}>
                <Text style={styles.alertType}>
                  {alert.type.replace(/_/g, " ")}
                </Text>
                <Text style={styles.alertMessage} numberOfLines={2}>
                  {alert.message}
                </Text>
                <Text style={styles.alertTime}>
                  {relativeTime(alert.createdAt)}
                </Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {/* Redirect Modal */}
      <Modal
        visible={redirectModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setRedirectModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Redirect Session</Text>
            <Text style={styles.modalSubtitle}>
              Enter new instructions for the session
            </Text>
            <TextInput
              style={styles.modalInput}
              multiline
              numberOfLines={4}
              value={redirectMessage}
              onChangeText={setRedirectMessage}
              placeholder="e.g., Focus on fixing the auth bug first..."
              placeholderTextColor={colors.textMuted}
              textAlignVertical="top"
            />
            <View style={styles.modalActions}>
              <Pressable
                style={styles.modalCancel}
                onPress={() => {
                  setRedirectModalVisible(false);
                  setRedirectMessage("");
                }}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.modalSend,
                  !redirectMessage.trim() && styles.modalSendDisabled,
                ]}
                onPress={handleRedirect}
                disabled={!redirectMessage.trim()}
              >
                <Text style={styles.modalSendText}>Send</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  loadingText: {
    color: colors.textSecondary,
    textAlign: "center",
    marginTop: 40,
    fontSize: 16,
  },
  section: {
    marginBottom: 24,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },
  sessionTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: colors.textPrimary,
    marginLeft: 8,
  },
  statusBadge: {
    fontSize: 14,
    fontWeight: "600",
    marginTop: 6,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  goalText: {
    fontSize: 16,
    color: colors.textSecondary,
    lineHeight: 24,
  },
  criterionRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 8,
  },
  criterionCheck: {
    fontSize: 16,
    marginRight: 8,
    marginTop: 1,
  },
  criterionText: {
    fontSize: 15,
    color: colors.textSecondary,
    flex: 1,
    lineHeight: 22,
  },
  criterionMet: {
    textDecorationLine: "line-through",
    color: colors.textMuted,
  },
  statsGrid: {
    flexDirection: "row",
    gap: 12,
  },
  statBox: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  statValue: {
    fontSize: 20,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  statLabel: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 4,
  },
  progressTrack: {
    height: 6,
    backgroundColor: colors.surface,
    borderRadius: 3,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: colors.primary,
    borderRadius: 3,
  },
  phaseText: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 6,
  },
  actionRow: {
    flexDirection: "row",
    gap: 12,
  },
  actionButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
  },
  stopButton: {
    backgroundColor: colors.danger,
  },
  redirectButton: {
    backgroundColor: colors.primary,
  },
  actionButtonText: {
    color: colors.white,
    fontSize: 16,
    fontWeight: "600",
  },
  alertRow: {
    backgroundColor: colors.card,
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  alertType: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.textMuted,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  alertMessage: {
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 20,
  },
  alertTime: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 4,
  },
  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  modalContent: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 40,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.textPrimary,
    marginBottom: 4,
  },
  modalSubtitle: {
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: 16,
  },
  modalInput: {
    backgroundColor: colors.bg,
    borderRadius: 10,
    padding: 14,
    fontSize: 15,
    color: colors.textPrimary,
    minHeight: 100,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginBottom: 16,
  },
  modalActions: {
    flexDirection: "row",
    gap: 12,
  },
  modalCancel: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    backgroundColor: colors.surface,
  },
  modalCancelText: {
    color: colors.textSecondary,
    fontSize: 16,
    fontWeight: "600",
  },
  modalSend: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    backgroundColor: colors.primary,
  },
  modalSendDisabled: {
    opacity: 0.5,
  },
  modalSendText: {
    color: colors.white,
    fontSize: 16,
    fontWeight: "600",
  },
});
