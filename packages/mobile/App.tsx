import React, { useCallback, useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";
import { RootNavigator } from "./src/navigation/RootNavigator";
import { GlobalMicFab } from "./src/components/GlobalMicFab";
import { wsManager } from "./src/services/ws";
import {
  requestPermissionsAndRegister,
  addNotificationResponseListener,
} from "./src/services/push";
import { getServerConfig, resetServerConfig, setServerConfigFromManualUrl } from "./src/config";
import { installGlobalErrorReporter, report as clientLog } from "./src/services/clientLog";

// Install the global error reporter as the very first thing the app does
// so red-screen failures during early boot also get forwarded.
installGlobalErrorReporter();

function ConnectingScreen(): React.JSX.Element {
  return (
    <View style={styles.connecting}>
      <ActivityIndicator size="large" color="#6366f1" />
      <Text style={styles.connectingText}>Searching for server...</Text>
      <Text style={styles.connectingSubtext}>
        Scanning your local network
      </Text>
    </View>
  );
}

function FailedScreen({
  onRetry,
  onManualConnect,
}: {
  onRetry: () => void;
  onManualConnect: (url: string) => void;
}): React.JSX.Element {
  const [url, setUrl] = useState("");
  const trimmed = url.trim();
  return (
    <View style={styles.connecting}>
      <Text style={styles.failedText}>Server not found</Text>
      <Text style={styles.connectingSubtext}>
        Make sure the NoSleep server is running on your network, or enter its
        URL manually.
      </Text>

      <TouchableOpacity style={styles.button} onPress={onRetry}>
        <Text style={styles.buttonText}>Retry discovery</Text>
      </TouchableOpacity>

      <TextInput
        style={styles.input}
        placeholder="http://192.168.x.x:3777"
        placeholderTextColor="#64748b"
        value={url}
        onChangeText={setUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <TouchableOpacity
        style={[styles.button, !trimmed && styles.buttonDisabled]}
        disabled={!trimmed}
        onPress={() => onManualConnect(trimmed)}
      >
        <Text style={styles.buttonText}>Connect to this URL</Text>
      </TouchableOpacity>
    </View>
  );
}

type ConnectionState = "discovering" | "connected" | "failed";

export default function App(): React.JSX.Element {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("discovering");

  // Run discovery and set connection state. Reused by initial boot + Retry.
  const attemptConnect = useCallback(async () => {
    setConnectionState("discovering");
    try {
      const config = await getServerConfig();
      if (config.apiUrl) {
        clientLog("info", "boot", "connected", {
          apiUrl: config.apiUrl,
          hasKey: Boolean(config.apiKey),
          keyLen: config.apiKey?.length ?? 0,
          keyPrefix: (config.apiKey ?? "").slice(0, 8),
        });
        setConnectionState("connected");
      } else {
        clientLog("warn", "boot", "discovery returned empty apiUrl");
        setConnectionState("failed");
      }
    } catch (err) {
      clientLog(
        "error",
        "boot",
        err instanceof Error ? err.message : String(err),
        undefined,
        err instanceof Error ? err.stack : undefined,
      );
      setConnectionState("failed");
    }
  }, []);

  useEffect(() => {
    void attemptConnect();
  }, [attemptConnect]);

  // Retry: clear the cached/failed config so discovery re-runs from scratch.
  const handleRetry = useCallback(async () => {
    await resetServerConfig();
    await attemptConnect();
  }, [attemptConnect]);

  // Manual URL override — reachable here because Settings is unmounted while
  // disconnected. Highest-priority config source (no health check), so a
  // wrong URL surfaces as in-app connection errors rather than trapping the
  // user on this screen.
  const handleManualConnect = useCallback(async (url: string) => {
    setConnectionState("discovering");
    try {
      const config = await setServerConfigFromManualUrl(url);
      setConnectionState(config.apiUrl ? "connected" : "failed");
    } catch (err) {
      clientLog("error", "boot", err instanceof Error ? err.message : String(err));
      setConnectionState("failed");
    }
  }, []);

  useEffect(() => {
    if (connectionState !== "connected") return;

    // Connect WebSocket after discovery completes
    wsManager.connect();

    // Register for push notifications
    requestPermissionsAndRegister().catch(() => {
      // User may deny permissions - that's fine
    });

    // Handle notification taps (deep linking)
    const subscription = addNotificationResponseListener((_response) => {
      // Navigation would be handled via notification content data
      // e.g., { screen: "Session", sessionId: "..." }
    });

    return () => {
      wsManager.disconnect();
      subscription.remove();
    };
  }, [connectionState]);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        {connectionState === "discovering" && <ConnectingScreen />}
        {connectionState === "failed" && (
          <FailedScreen onRetry={handleRetry} onManualConnect={handleManualConnect} />
        )}
        {connectionState === "connected" && (
          <>
            <RootNavigator />
            <GlobalMicFab />
          </>
        )}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  connecting: {
    flex: 1,
    backgroundColor: "#0f172a",
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  connectingText: {
    color: "#f8fafc",
    fontSize: 18,
    fontWeight: "600",
    marginTop: 20,
  },
  connectingSubtext: {
    color: "#94a3b8",
    fontSize: 14,
    marginTop: 8,
    textAlign: "center",
  },
  failedText: {
    color: "#ef4444",
    fontSize: 20,
    fontWeight: "700",
  },
  button: {
    backgroundColor: "#6366f1",
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 10,
    marginTop: 20,
    minWidth: 220,
    alignItems: "center",
  },
  buttonDisabled: {
    backgroundColor: "#334155",
  },
  buttonText: {
    color: "#f8fafc",
    fontSize: 16,
    fontWeight: "600",
  },
  input: {
    marginTop: 24,
    width: 280,
    backgroundColor: "#1e293b",
    color: "#f8fafc",
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 15,
    borderWidth: 1,
    borderColor: "#334155",
  },
});
