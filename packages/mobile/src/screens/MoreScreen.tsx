/**
 * "More" tab — overflow nav for screens that don't deserve a bottom-tab slot.
 * Keeps the tab bar at 5 main destinations so they don't cram on small devices.
 */

import React from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { colors } from "../theme";

interface Item {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  to: string;
  description?: string;
}

const ITEMS: Item[] = [
  { label: "Strategy", icon: "git-branch", to: "Strategy", description: "Strategy tree + tasks" },
  { label: "Schedules", icon: "timer", to: "Schedules", description: "Recurring sessions" },
  { label: "Token Usage", icon: "stats-chart", to: "Tokens", description: "Per-org spend" },
  { label: "Metrics", icon: "speedometer", to: "Metrics", description: "System CPU/mem/GPU" },
  { label: "Settings", icon: "settings", to: "Settings", description: "Server URL, push, theme" },
];

export function MoreScreen(): React.JSX.Element {
  const navigation = useNavigation<{
    navigate: (target: string) => void;
  }>();

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>More</Text>
        <View style={styles.list}>
          {ITEMS.map((item) => (
            <TouchableOpacity
              key={item.to}
              style={styles.row}
              onPress={() => navigation.navigate(item.to)}
              activeOpacity={0.7}
            >
              <View style={styles.iconWrap}>
                <Ionicons name={item.icon} size={22} color={colors.primary} />
              </View>
              <View style={styles.body}>
                <Text style={styles.label}>{item.label}</Text>
                {item.description && (
                  <Text style={styles.description}>{item.description}</Text>
                )}
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 16 },
  title: {
    color: colors.textPrimary,
    fontSize: 26,
    fontWeight: "700",
    marginBottom: 16,
  },
  list: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderBottomColor: colors.cardBorder,
    borderBottomWidth: 1,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: "rgba(99,102,241,0.12)",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  body: { flex: 1 },
  label: { color: colors.textPrimary, fontSize: 16, fontWeight: "600" },
  description: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
});
