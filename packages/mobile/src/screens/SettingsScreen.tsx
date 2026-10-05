import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  StyleSheet,
  Alert as RNAlert,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { requestPermissionsAndRegister } from "../services/push";
import { wsManager } from "../services/ws";
import { colors } from "../theme";
import { getServerConfig, resetServerConfig, setServerConfigFromManualUrl } from "../config";
import { saveApiKey, getApiKey, saveManualServerUrl, getManualServerUrl, normalizeServerUrl } from "../services/discovery";

export function SettingsScreen(): React.JSX.Element {
  const [pushRegistered, setPushRegistered] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [savedKey, setSavedKey] = useState("");
  const [manualUrlInput, setManualUrlInput] = useState("");
  const [savedManualUrl, setSavedManualUrl] = useState("");
  const [serverUrl, setServerUrl] = useState("discovering...");
  const [wsUrl, setWsUrl] = useState("discovering...");
  const [wsConnected, setWsConnected] = useState(wsManager.isConnected());
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    getApiKey().then((k) => {
      setSavedKey(k);
      setApiKeyInput(k);
    });
    getManualServerUrl().then((url) => {
      const val = url ?? "";
      setSavedManualUrl(val);
      setManualUrlInput(val);
    });
    getServerConfig().then((c) => {
      setServerUrl(c.apiUrl);
      setWsUrl(c.wsUrl);
    });
    const unsub = wsManager.onConnectionChange(setWsConnected);
    return unsub;
  }, []);

  const refreshConnectionInfo = useCallback(async () => {
    const config = await getServerConfig();
    setServerUrl(config.apiUrl);
    setWsUrl(config.wsUrl);
    wsManager.disconnect();
    wsManager.connect();
  }, []);

  const handleSaveManualUrl = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const normalized = normalizeServerUrl(manualUrlInput);
      await saveManualServerUrl(manualUrlInput);
      setSavedManualUrl(normalized);
      setManualUrlInput(normalized || "");

      if (normalized) {
        // Instant — set config directly, no discovery
        const config = await setServerConfigFromManualUrl(normalized);
        setServerUrl(config.apiUrl);
        setWsUrl(config.wsUrl);
        wsManager.disconnect();
        wsManager.connect();
        RNAlert.alert("Server URL", `Set to ${normalized}`);
      } else {
        // Cleared — fall back to auto-discovery
        await resetServerConfig();
        await refreshConnectionInfo();
        RNAlert.alert("Server URL", "Cleared. Using auto-discovery.");
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [manualUrlInput, refreshConnectionInfo]);

  const handleSaveApiKey = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const trimmed = apiKeyInput.trim();
      await saveApiKey(trimmed);
      setSavedKey(trimmed);
      await resetServerConfig();
      await refreshConnectionInfo();
      RNAlert.alert("API Key", trimmed ? "Key saved. Reconnecting..." : "Key cleared.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [apiKeyInput, refreshConnectionInfo]);

  const handleRegisterPush = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const token = await requestPermissionsAndRegister();
      if (token) {
        setPushRegistered(true);
        RNAlert.alert("Push Notifications", `Registered!\n\nToken: ${token.slice(0, 30)}...`);
      } else {
        RNAlert.alert(
          "Push Notifications",
          "Permission denied. Please enable notifications in iOS Settings for NoSleep."
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      RNAlert.alert("Push Error", msg);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const handleReconnectWs = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await resetServerConfig();
      await refreshConnectionInfo();
      RNAlert.alert("Connection", "Re-discovering server and reconnecting...");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [refreshConnectionInfo]);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Manual Server URL */}
        <Text style={styles.sectionTitle}>Server URL</Text>
        <View style={styles.card}>
          <Text style={styles.hint}>
            Set a manual server URL (e.g. http://100.x.x.x:3777 for Tailscale).
            Leave empty for auto-discovery.
          </Text>
          <TextInput
            style={styles.textInput}
            value={manualUrlInput}
            onChangeText={setManualUrlInput}
            placeholder="http://100.x.x.x:3777"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            selectTextOnFocus
          />
          <Pressable
            style={[
              styles.actionButton,
              { marginTop: 10, marginBottom: 0 },
              busy && styles.actionButtonDisabled,
            ]}
            onPress={handleSaveManualUrl}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color={colors.primary} size="small" />
            ) : (
              <Text style={styles.actionButtonText}>
                {savedManualUrl ? "Update Server URL" : "Save Server URL"}
              </Text>
            )}
          </Pressable>
          {savedManualUrl ? (
            <Text style={styles.savedIndicator}>
              Using: {savedManualUrl}
            </Text>
          ) : (
            <Text style={[styles.savedIndicator, { color: colors.textMuted }]}>
              Auto-discovery active
            </Text>
          )}
        </View>

        {/* API Key */}
        <Text style={styles.sectionTitle}>API Key</Text>
        <View style={styles.card}>
          <Text style={styles.hint}>
            Enter the NOSLEEP_API_KEY from your server .env file
          </Text>
          <TextInput
            style={styles.textInput}
            value={apiKeyInput}
            onChangeText={setApiKeyInput}
            placeholder="Paste API key here..."
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={false}
            selectTextOnFocus
          />
          <Pressable
            style={[
              styles.actionButton,
              { marginTop: 10, marginBottom: 0 },
              busy && styles.actionButtonDisabled,
            ]}
            onPress={handleSaveApiKey}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color={colors.primary} size="small" />
            ) : (
              <Text style={styles.actionButtonText}>
                {savedKey ? "Update API Key" : "Save API Key"}
              </Text>
            )}
          </Pressable>
          {savedKey ? (
            <Text style={styles.savedIndicator}>
              Key configured ({savedKey.slice(0, 8)}...)
            </Text>
          ) : (
            <Text style={[styles.savedIndicator, { color: colors.danger }]}>
              No key configured — API calls will fail
            </Text>
          )}
        </View>

        {/* Connection Info */}
        <Text style={styles.sectionTitle}>Connection</Text>
        <View style={styles.card}>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>API Server</Text>
            <Text style={styles.infoValue}>{serverUrl}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>WebSocket</Text>
            <Text style={styles.infoValue}>{wsUrl.split("?")[0]}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>WS Status</Text>
            <Text
              style={[
                styles.infoValue,
                {
                  color: wsConnected
                    ? colors.success
                    : colors.danger,
                },
              ]}
            >
              {wsConnected ? "Connected" : "Disconnected"}
            </Text>
          </View>
        </View>

        {/* Actions */}
        <Text style={styles.sectionTitle}>Actions</Text>
        <Pressable
          style={[styles.actionButton, busy && styles.actionButtonDisabled]}
          onPress={handleRegisterPush}
          disabled={busy}
        >
          <Text style={styles.actionButtonText}>
            {pushRegistered
              ? "Push Notifications Registered"
              : "Register Push Notifications"}
          </Text>
        </Pressable>

        <Pressable
          style={[styles.actionButton, busy && styles.actionButtonDisabled]}
          onPress={handleReconnectWs}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color={colors.primary} size="small" />
          ) : (
            <Text style={styles.actionButtonText}>Rediscover Server</Text>
          )}
        </Pressable>

        {/* About */}
        <Text style={styles.sectionTitle}>About</Text>
        <View style={styles.card}>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>App</Text>
            <Text style={styles.infoValue}>NoSleep Mobile</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Version</Text>
            <Text style={styles.infoValue}>1.0.0</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 10,
    marginTop: 20,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
  },
  infoLabel: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  infoValue: {
    fontSize: 14,
    color: colors.textPrimary,
    fontWeight: "500",
    maxWidth: "60%",
    textAlign: "right",
  },
  hint: {
    fontSize: 13,
    color: colors.textMuted,
    marginBottom: 10,
  },
  textInput: {
    backgroundColor: colors.bg,
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    fontFamily: "monospace",
  },
  savedIndicator: {
    fontSize: 12,
    color: colors.success,
    marginTop: 8,
    textAlign: "center",
  },
  actionButton: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    alignItems: "center",
  },
  actionButtonDisabled: {
    opacity: 0.5,
  },
  actionButtonText: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: "600",
  },
});
