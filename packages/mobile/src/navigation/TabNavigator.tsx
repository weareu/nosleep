import React, { useState, useEffect, useCallback, useRef } from "react";
import { AppState } from "react-native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";
import { DashboardScreen } from "../screens/DashboardScreen";
import { ProjectsScreen } from "../screens/ProjectsScreen";
import { StrategyScreen } from "../screens/StrategyScreen";
import { AlertsScreen } from "../screens/AlertsScreen";
import { TokenUsageScreen } from "../screens/TokenUsageScreen";
import { SchedulesScreen } from "../screens/SchedulesScreen";
import { MetricsScreen } from "../screens/MetricsScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { BrainHomeScreen } from "../screens/BrainHomeScreen";
import { MoreScreen } from "../screens/MoreScreen";
import { listAlerts } from "../services/api";
import { wsManager } from "../services/ws";
import { useWsEvent } from "../hooks/useWsEvent";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, TAB_BAR_HEIGHT } from "../theme";
import { MicTabButton } from "../components/MicTabButton";

type TabParamList = {
  Dashboard: undefined;
  Projects: undefined;
  Capture: undefined;
  Brain: undefined;
  Alerts: undefined;
  More: undefined;
};

const Tab = createBottomTabNavigator<TabParamList>();

/** The "Capture" tab never navigates — its button opens the mic sheet. */
function CapturePlaceholder(): null {
  return null;
}

type MoreStackParamList = {
  MoreMenu: undefined;
  Strategy: undefined;
  Schedules: undefined;
  Tokens: undefined;
  Metrics: undefined;
  Settings: undefined;
};

const MoreStack = createNativeStackNavigator<MoreStackParamList>();

function MoreStackNavigator(): React.JSX.Element {
  return (
    <MoreStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.textPrimary,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <MoreStack.Screen
        name="MoreMenu"
        component={MoreScreen}
        // title feeds the back button on pushed screens ("< More", not
        // the route name "< MoreMenu").
        options={{ headerShown: false, title: "More" }}
      />
      <MoreStack.Screen
        name="Strategy"
        component={StrategyScreen}
        options={{ title: "Strategy" }}
      />
      <MoreStack.Screen
        name="Schedules"
        component={SchedulesScreen}
        options={{ title: "Schedules" }}
      />
      <MoreStack.Screen
        name="Tokens"
        component={TokenUsageScreen}
        options={{ title: "Token Usage" }}
      />
      <MoreStack.Screen
        name="Metrics"
        component={MetricsScreen}
        options={{ title: "Metrics" }}
      />
      <MoreStack.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ title: "Settings" }}
      />
    </MoreStack.Navigator>
  );
}

export function TabNavigator(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [unackedCount, setUnackedCount] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadAlertCount = useCallback(async () => {
    try {
      const alerts = await listAlerts({ unackedOnly: true });
      setUnackedCount(alerts.length);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    wsManager.connect();
    loadAlertCount();
    pollRef.current = setInterval(loadAlertCount, 15000);
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        wsManager.connect();
        loadAlertCount();
      }
    });
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      sub.remove();
    };
  }, [loadAlertCount]);

  const handleAlertUpdate = useCallback(() => {
    loadAlertCount();
  }, [loadAlertCount]);

  // Phase 12 (UI review #2 — M1) — light haptic so a new alert is felt
  // even when the user is on a different tab. expo-haptics is loaded
  // lazily so the app builds without it.
  const handleAlertNew = useCallback(() => {
    loadAlertCount();
    void (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Haptics = require("expo-haptics") as {
          notificationAsync: (t: string) => Promise<void>;
          NotificationFeedbackType: { Warning: string };
        };
        await Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Warning,
        );
      } catch {
        /* haptics not installed — silent no-op */
      }
    })();
  }, [loadAlertCount]);

  useWsEvent("alert:new", handleAlertNew);
  useWsEvent("alert:ack", handleAlertUpdate);

  return (
    <Tab.Navigator
      screenOptions={{
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.cardBorder,
          borderTopWidth: 1,
          height: TAB_BAR_HEIGHT + insets.bottom,
        },
        // Dashboard · Projects · [mic] · Brain · Alerts · More. The centre
        // mic is docked IN the bar so it never covers screen content.
        // Strategy / Schedules / Tokens / Metrics / Settings live under More.
        // Explicit 14px line box (with TAB_BAR_HEIGHT leaving room for it):
        // the squeezed default clipped the "j" in "Projects" ("Proiects").
        tabBarLabelStyle: { fontSize: 10, lineHeight: 14, fontWeight: "600" },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        headerShown: false,
      }}
    >
      <Tab.Screen
        name="Dashboard"
        component={DashboardScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Projects"
        component={ProjectsScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="folder" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Capture"
        component={CapturePlaceholder}
        options={{ tabBarButton: () => <MicTabButton /> }}
        listeners={{ tabPress: (e) => e.preventDefault() }}
      />
      <Tab.Screen
        name="Brain"
        component={BrainHomeScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="bulb" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Alerts"
        component={AlertsScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="notifications" size={size} color={color} />
          ),
          tabBarBadge: unackedCount > 0 ? unackedCount : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.danger, fontSize: 11 },
        }}
      />
      <Tab.Screen
        name="More"
        component={MoreStackNavigator}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="ellipsis-horizontal" size={size} color={color} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}
