import React, { useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  Animated,
  PanResponder,
} from "react-native";
import * as Haptics from "expo-haptics";
import { colors, getOrgColor, getSeverityColor } from "../theme";
import { relativeTime } from "../utils";
import type { Alert } from "../types";

interface AlertItemProps {
  readonly alert: Alert;
  readonly onAcknowledge: (id: number) => void;
}

const SWIPE_THRESHOLD = -80;

export function AlertItem({
  alert,
  onAcknowledge,
}: AlertItemProps): React.JSX.Element {
  const translateX = useRef(new Animated.Value(0)).current;

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) =>
        Math.abs(gestureState.dx) > 10 && !alert.acknowledged,
      onPanResponderMove: (_, gestureState) => {
        if (gestureState.dx < 0) {
          translateX.setValue(gestureState.dx);
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dx < SWIPE_THRESHOLD) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          Animated.timing(translateX, {
            toValue: -300,
            duration: 200,
            useNativeDriver: true,
          }).start(() => {
            onAcknowledge(alert.id);
          });
        } else {
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: true,
          }).start();
        }
      },
    })
  ).current;

  const orgColor = getOrgColor(alert.orgId);
  const severityColor = getSeverityColor(alert.severity);

  return (
    <View style={styles.container}>
      {/* Background revealed on swipe */}
      <View style={styles.swipeBackground}>
        <Text style={styles.swipeText}>Acknowledge</Text>
      </View>

      <Animated.View
        style={[
          styles.card,
          {
            transform: [{ translateX }],
            opacity: alert.acknowledged ? 0.5 : 1,
          },
        ]}
        {...panResponder.panHandlers}
      >
        <View style={[styles.orgStripe, { backgroundColor: orgColor }]} />

        <View style={styles.content}>
          <View style={styles.header}>
            <View
              style={[
                styles.typeBadge,
                { backgroundColor: `${severityColor}20` },
              ]}
            >
              <Text style={[styles.typeText, { color: severityColor }]}>
                {alert.type.replace(/_/g, " ")}
              </Text>
            </View>
            <Text style={styles.time}>{relativeTime(alert.createdAt)}</Text>
          </View>

          {alert.projectName && (
            <Text style={styles.projectName}>{alert.projectName}</Text>
          )}

          <Text style={styles.message} numberOfLines={3}>
            {alert.message}
          </Text>

          {alert.acknowledged && (
            <Text style={styles.ackedLabel}>Acknowledged</Text>
          )}
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: 16,
    marginBottom: 8,
    position: "relative",
  },
  swipeBackground: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    left: 0,
    backgroundColor: colors.success,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "flex-end",
    paddingRight: 20,
  },
  swipeText: {
    color: colors.white,
    fontWeight: "600",
    fontSize: 14,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    flexDirection: "row",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  orgStripe: {
    width: 4,
  },
  content: {
    flex: 1,
    padding: 12,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  typeBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  typeText: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
  },
  time: {
    fontSize: 12,
    color: colors.textMuted,
  },
  projectName: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.textPrimary,
    marginBottom: 4,
  },
  message: {
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 20,
  },
  ackedLabel: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 4,
    fontStyle: "italic",
  },
});
