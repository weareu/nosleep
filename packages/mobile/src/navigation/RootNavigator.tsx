import React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { TabNavigator } from "./TabNavigator";
import { SessionScreen } from "../screens/SessionScreen";
import { LaunchScreen } from "../screens/LaunchScreen";
import { StrategyNodeScreen } from "../screens/StrategyNodeScreen";
import { TerminalScreen } from "../screens/TerminalScreen";
import { BrainArtifactScreen } from "../screens/BrainArtifactScreen";
import { BrainSessionScreen } from "../screens/BrainSessionScreen";
import { colors } from "../theme";

export type RootStackParamList = {
  Tabs: undefined;
  Session: { sessionId: string };
  Launch: { projectId: string; projectName: string };
  StrategyNode: { nodeId: string; title: string };
  Terminal: { sessionId: string; projectName: string; orgId?: string };
  BrainArtifact: { hash: string; orgId: string };
  BrainSession: { sessionId: string; orgId: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator(): React.JSX.Element {
  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerStyle: {
            backgroundColor: colors.bg,
          },
          headerTintColor: colors.textPrimary,
          headerTitleStyle: {
            fontWeight: "600",
          },
          contentStyle: {
            backgroundColor: colors.bg,
          },
        }}
      >
        <Stack.Screen
          name="Tabs"
          component={TabNavigator}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="Session"
          component={SessionScreen as any}
          options={{
            title: "Session Details",
            headerBackTitle: "Back",
          }}
        />
        <Stack.Screen
          name="Launch"
          component={LaunchScreen as any}
          options={{
            title: "Launch Session",
            headerBackTitle: "Back",
            presentation: "modal",
          }}
        />
        <Stack.Screen
          name="StrategyNode"
          component={StrategyNodeScreen as any}
          options={({ route }) => ({
            title: (route.params as any)?.title ?? "Node",
            headerBackTitle: "Back",
          })}
        />
        <Stack.Screen
          name="Terminal"
          component={TerminalScreen as any}
          options={({ route }) => ({
            title: `Terminal: ${(route.params as any)?.projectName ?? "Session"}`,
            headerBackTitle: "Back",
          })}
        />
        <Stack.Screen
          name="BrainArtifact"
          component={BrainArtifactScreen as any}
          options={{ title: "Artifact", headerBackTitle: "Back" }}
        />
        <Stack.Screen
          name="BrainSession"
          component={BrainSessionScreen as any}
          options={{ title: "Brain Session", headerBackTitle: "Back" }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
