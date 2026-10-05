import React, { useEffect, useRef } from "react";
import { View, Animated, StyleSheet } from "react-native";
import { getStatusColor } from "../theme";

interface StatusDotProps {
  readonly status: string;
  readonly size?: number;
}

export function StatusDot({ status, size = 10 }: StatusDotProps): React.JSX.Element {
  const color = getStatusColor(status);
  const isActive = ["starting", "running", "waiting_input"].includes(status);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (isActive) {
      const animation = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 0.4,
            duration: 1000,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 1000,
            useNativeDriver: true,
          }),
        ])
      );
      animation.start();
      return () => animation.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isActive, pulseAnim]);

  return (
    <View style={styles.container}>
      {isActive && (
        <Animated.View
          style={[
            styles.pulse,
            {
              width: size * 2,
              height: size * 2,
              borderRadius: size,
              backgroundColor: `${color}30`,
              opacity: pulseAnim,
            },
          ]}
        />
      )}
      <View
        style={[
          styles.dot,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: color,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 24,
  },
  pulse: {
    position: "absolute",
  },
  dot: {},
});
