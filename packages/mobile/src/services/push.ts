import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { registerPushToken } from "./api";

// Configure how notifications are displayed when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlayNotificationSound: true,
  }),
});

export async function requestPermissionsAndRegister(): Promise<string | null> {
  const { status: existingStatus } =
    await Notifications.getPermissionsAsync();

  let finalStatus = existingStatus;

  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== "granted") {
    return null;
  }

  // Push tokens belong to the builder's EAS project (EAS_PROJECT_ID → app.config.js).
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  if (!projectId) {
    console.warn("[push] no EAS project id configured (set EAS_PROJECT_ID) — push disabled");
    return null;
  }
  const tokenResponse = await Notifications.getExpoPushTokenAsync({ projectId });

  const token = tokenResponse.data;

  // Register token with our server
  try {
    await registerPushToken(token);
  } catch {
    // Server registration failed, but we still have the token locally
  }

  return token;
}

export function addNotificationReceivedListener(
  handler: (notification: Notifications.Notification) => void
): Notifications.EventSubscription {
  return Notifications.addNotificationReceivedListener(handler);
}

export function addNotificationResponseListener(
  handler: (response: Notifications.NotificationResponse) => void
): Notifications.EventSubscription {
  return Notifications.addNotificationResponseReceivedListener(handler);
}

export async function setBadgeCount(count: number): Promise<void> {
  if (Platform.OS === "ios") {
    await Notifications.setBadgeCountAsync(count);
  }
}
