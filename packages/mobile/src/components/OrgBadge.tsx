import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { getOrgColor, ORG_NAMES } from "../theme";

interface OrgBadgeProps {
  readonly orgId: string;
  readonly size?: "small" | "medium";
}

export function OrgBadge({ orgId, size = "small" }: OrgBadgeProps): React.JSX.Element {
  const color = getOrgColor(orgId);
  const name = ORG_NAMES[orgId] ?? orgId;
  const isSmall = size === "small";

  return (
    <View
      style={[
        styles.badge,
        {
          backgroundColor: `${color}20`,
          borderColor: `${color}40`,
          paddingHorizontal: isSmall ? 8 : 10,
          paddingVertical: isSmall ? 2 : 4,
        },
      ]}
    >
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text
        style={[
          styles.text,
          { color, fontSize: isSmall ? 11 : 13 },
        ]}
      >
        {name}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 4,
  },
  text: {
    fontWeight: "600",
  },
});
