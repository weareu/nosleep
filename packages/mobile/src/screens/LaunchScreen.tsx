import React, { useState, useCallback, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  Switch,
  StyleSheet,
  Alert as RNAlert,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { launchSession, getNextActionable } from "../services/api";
import { colors } from "../theme";

interface LaunchScreenProps {
  readonly route: {
    params: { projectId: string; projectName: string };
  };
}

export function LaunchScreen({ route }: LaunchScreenProps): React.JSX.Element {
  const { projectId, projectName } = route.params;
  const navigation = useNavigation();
  const [autoMode, setAutoMode] = useState(false);
  const [goal, setGoal] = useState("");
  const [criteria, setCriteria] = useState<string[]>([""]);
  const [launching, setLaunching] = useState(false);
  const [loadingNext, setLoadingNext] = useState(false);
  const [nextTask, setNextTask] = useState<{
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    type: string;
  } | null>(null);

  // Fetch next actionable task when auto mode is toggled on
  useEffect(() => {
    if (!autoMode) {
      setNextTask(null);
      return;
    }
    setLoadingNext(true);
    getNextActionable(projectId)
      .then((data: any) => {
        if (data?.id) {
          let parsedCriteria: string[] = [];
          try {
            const raw = data.acceptanceCriteria ?? data.acceptance_criteria;
            parsedCriteria = typeof raw === "string" ? JSON.parse(raw) : Array.isArray(raw) ? raw : [];
          } catch { /* */ }
          setNextTask({
            id: data.id,
            title: data.title,
            description: data.description ?? "",
            acceptanceCriteria: parsedCriteria,
            type: data.type,
          });
          setGoal(`[${data.type}] ${data.title}${data.description ? ": " + data.description : ""}`);
          setCriteria(parsedCriteria.length > 0 ? parsedCriteria : [""]);
        } else {
          setNextTask(null);
          RNAlert.alert("No Tasks", "No actionable tasks in the strategy tree for this project.");
          setAutoMode(false);
        }
      })
      .catch(() => {
        setNextTask(null);
        RNAlert.alert("Error", "Could not fetch next task from strategy tree.");
        setAutoMode(false);
      })
      .finally(() => setLoadingNext(false));
  }, [autoMode, projectId]);

  const addCriterion = useCallback(() => {
    setCriteria((prev) => [...prev, ""]);
  }, []);

  const removeCriterion = useCallback((index: number) => {
    setCriteria((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const updateCriterion = useCallback((index: number, value: string) => {
    setCriteria((prev) => prev.map((c, i) => (i === index ? value : c)));
  }, []);

  const handleLaunch = useCallback(async () => {
    if (!goal.trim()) {
      RNAlert.alert("Missing Goal", "Please enter a goal or enable auto mode.");
      return;
    }

    const validCriteria = criteria.filter((c) => c.trim().length > 0);

    RNAlert.alert(
      "Launch Session",
      autoMode && nextTask
        ? `Launch next task: "${nextTask.title}"?`
        : `Launch a new session for ${projectName}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Launch",
          onPress: async () => {
            await Haptics.notificationAsync(
              Haptics.NotificationFeedbackType.Success
            );
            setLaunching(true);
            try {
              await launchSession({
                projectId,
                goal: goal.trim(),
                acceptanceCriteria: validCriteria,
                strategyNodeId: nextTask?.id,
              });
              navigation.goBack();
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Unknown error";
              RNAlert.alert("Launch Failed", message);
            } finally {
              setLaunching(false);
            }
          },
        },
      ]
    );
  }, [goal, criteria, projectId, projectName, navigation, autoMode, nextTask]);

  return (
    <SafeAreaView style={styles.container} edges={["bottom"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.projectLabel}>Project</Text>
          <Text style={styles.projectName}>{projectName}</Text>

          {/* Auto Mode Toggle */}
          <View style={styles.autoModeRow}>
            <View style={styles.autoModeLabel}>
              <Text style={styles.label}>Next from Strategy Tree</Text>
              <Text style={styles.autoModeHint}>
                Auto-pick the next actionable task
              </Text>
            </View>
            <Switch
              value={autoMode}
              onValueChange={setAutoMode}
              trackColor={{ false: colors.cardBorder, true: colors.primary }}
              thumbColor={colors.white}
            />
          </View>

          {/* Loading indicator for tree fetch */}
          {loadingNext && (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.loadingText}>Finding next task...</Text>
            </View>
          )}

          {/* Show fetched task info */}
          {autoMode && nextTask && (
            <View style={styles.taskPreview}>
              <Text style={styles.taskPreviewType}>[{nextTask.type}]</Text>
              <Text style={styles.taskPreviewTitle}>{nextTask.title}</Text>
              {nextTask.description ? (
                <Text style={styles.taskPreviewDesc}>
                  {nextTask.description.slice(0, 200)}
                </Text>
              ) : null}
              {nextTask.acceptanceCriteria.length > 0 && (
                <View style={styles.taskPreviewCriteria}>
                  {nextTask.acceptanceCriteria.map((c, i) => (
                    <Text key={i} style={styles.taskPreviewCriterion}>
                      {i + 1}. {c}
                    </Text>
                  ))}
                </View>
              )}
            </View>
          )}

          {/* Manual Goal (hidden in auto mode) */}
          {!autoMode && (
            <>
              <Text style={styles.label}>Goal</Text>
              <TextInput
                style={styles.goalInput}
                multiline
                numberOfLines={4}
                value={goal}
                onChangeText={setGoal}
                placeholder="Describe what the session should accomplish..."
                placeholderTextColor={colors.textMuted}
                textAlignVertical="top"
              />

              <View style={styles.criteriaHeader}>
                <Text style={styles.label}>Acceptance Criteria</Text>
                <Pressable onPress={addCriterion} style={styles.addButton}>
                  <Text style={styles.addButtonText}>+ Add</Text>
                </Pressable>
              </View>

              {criteria.map((criterion, index) => (
                <View key={index} style={styles.criterionRow}>
                  <TextInput
                    style={styles.criterionInput}
                    value={criterion}
                    onChangeText={(text) => updateCriterion(index, text)}
                    placeholder={`Criterion ${index + 1}`}
                    placeholderTextColor={colors.textMuted}
                  />
                  {criteria.length > 1 && (
                    <Pressable
                      onPress={() => removeCriterion(index)}
                      style={styles.removeButton}
                    >
                      <Text style={styles.removeButtonText}>X</Text>
                    </Pressable>
                  )}
                </View>
              ))}
            </>
          )}

          {/* Launch Button */}
          <Pressable
            style={[
              styles.launchButton,
              (!goal.trim() || launching) && styles.launchButtonDisabled,
            ]}
            onPress={handleLaunch}
            disabled={!goal.trim() || launching}
          >
            <Text style={styles.launchButtonText}>
              {launching
                ? "Launching..."
                : autoMode && nextTask
                  ? `Launch: ${nextTask.title.slice(0, 30)}...`
                  : "Launch Session"}
            </Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  flex: {
    flex: 1,
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 40,
  },
  projectLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  projectName: {
    fontSize: 22,
    fontWeight: "700",
    color: colors.textPrimary,
    marginBottom: 24,
  },
  autoModeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginBottom: 16,
  },
  autoModeLabel: {
    flex: 1,
    marginRight: 12,
  },
  autoModeHint: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 16,
  },
  loadingText: {
    fontSize: 14,
    color: colors.textMuted,
  },
  taskPreview: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.primary,
    marginBottom: 16,
  },
  taskPreviewType: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.primary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  taskPreviewTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.textPrimary,
    marginBottom: 6,
  },
  taskPreviewDesc: {
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: 8,
  },
  taskPreviewCriteria: {
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    paddingTop: 8,
  },
  taskPreviewCriterion: {
    fontSize: 12,
    color: colors.textMuted,
    marginBottom: 3,
  },
  label: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  goalInput: {
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 14,
    fontSize: 15,
    color: colors.textPrimary,
    minHeight: 100,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginBottom: 24,
  },
  criteriaHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  addButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: `${colors.primary}20`,
  },
  addButtonText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: "600",
  },
  criterionRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
    gap: 8,
  },
  criterionInput: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  removeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: `${colors.danger}20`,
    alignItems: "center",
    justifyContent: "center",
  },
  removeButtonText: {
    color: colors.danger,
    fontSize: 14,
    fontWeight: "700",
  },
  launchButton: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 32,
  },
  launchButtonDisabled: {
    opacity: 0.5,
  },
  launchButtonText: {
    color: colors.white,
    fontSize: 17,
    fontWeight: "700",
  },
});
