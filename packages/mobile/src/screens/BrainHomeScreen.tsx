/**
 * Brain — single tab containing two sub-sections: Search and Capture.
 * Segmented control at the top swaps between them. Saves a tab slot in
 * the bottom bar while keeping both flows reachable in one tap.
 */

import React, { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BrainSearchScreen } from "./BrainSearchScreen";
import { BrainCaptureScreen } from "./BrainCaptureScreen";
import { colors } from "../theme";

type Section = "search" | "capture";

export function BrainHomeScreen(): React.JSX.Element {
  const [section, setSection] = useState<Section>("search");

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.segmented}>
        <SegmentedButton
          label="Search"
          active={section === "search"}
          onPress={() => setSection("search")}
        />
        <SegmentedButton
          label="Capture"
          active={section === "capture"}
          onPress={() => setSection("capture")}
        />
      </View>
      {/*
        Phase 12 (UI review L2) — Capture stays mounted always (so the
        in-progress draft + queued offline captures + photo selection
        survive a tab switch). Search is mounted on demand: cold start is
        cheap, and the mounted-but-hidden case wasted memory + re-rendered
        on every result fetch while the user was on Capture.
      */}
      {section === "search" && (
        <View style={styles.body}>
          <BrainSearchScreen />
        </View>
      )}
      <View
        style={[styles.body, section !== "capture" && styles.hidden]}
        pointerEvents={section === "capture" ? "auto" : "none"}
      >
        <BrainCaptureScreen />
      </View>
    </SafeAreaView>
  );
}

function SegmentedButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <TouchableOpacity
      style={[styles.segmentBtn, active && styles.segmentBtnActive]}
      onPress={onPress}
      activeOpacity={0.8}
    >
      <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  segmented: {
    flexDirection: "row",
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 999,
    padding: 3,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 999,
    alignItems: "center",
  },
  segmentBtnActive: { backgroundColor: colors.primary },
  segmentText: { color: colors.textSecondary, fontWeight: "600", fontSize: 14 },
  segmentTextActive: { color: colors.white },
  body: { flex: 1 },
  // RN supports display:'none' on Views — children stay mounted,
  // tree intact, but no layout cost.
  hidden: { display: "none", flex: 0 },
});
