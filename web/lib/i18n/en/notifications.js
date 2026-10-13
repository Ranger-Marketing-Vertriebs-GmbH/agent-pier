export const notificationCopy = {
  title: "App & notifications",
  description: "Install AgentPier and explicitly enable notifications on this device.",
  installTitle: "AgentPier as an app",
  install: "Install app",
  installed: "AgentPier is already running as an installed app.",
  installHelp:
    "Choose “Install app” or “Add to Home Screen” in your browser menu. On iPhone and iPad, push notifications are available from iOS 16.4 in the installed home screen app.",
  offlinePrivacy:
    "Only a public notice appears offline. Sessions, chats, API responses and credentials are not stored for offline use.",
  pushTitle: "Notifications on this device",
  pushPrivacy:
    "Notifications contain only the event type. Tasks, commands and chat content stay private. A notification opens the relevant view; it does not approve any action.",
  unsupported:
    "This browser does not support push notifications here. A secure HTTPS connection or localhost and a supported browser are required.",
  denied:
    "Notifications are blocked in the browser. Change the site permission in browser settings and reload this view.",
  appGroup: "App",
  installedStatus: "Installed",
  notInstalled: "Running in the browser.",
  pushToggle: "Notifications",
  deviceLabel: "Device name",
  saveName: "Save name",
  thisDevice: "This device",
  unnamedDevice: "Unnamed device",
  deviceName: (browser, platform, app) =>
    `${browser || "Browser"}${platform ? ` on ${platform}` : ""}${app ? " (app)" : ""}`,
  active: "Enabled on this device.",
  inactive: "Not enabled on this device.",
  incomplete: "Not fully enabled. Turn it off and on again.",
  test: "Send test notification",
  sent: "Test notification sent.",
  testFailed: "The test notification could not be sent.",
  permissionRequired: "Browser permission was not granted.",
  storageFailed:
    "The device identifier could not be saved. Allow local site storage and try again.",
  unsubscribeFailed:
    "The server subscription was removed. The browser subscription could not be removed yet. Please try again.",
  loading: "Loading settings …",
  unavailable: "Notifications are unavailable on this server.",
  devices: "Registered devices",
  remove: "Unregister",
  removeNamed: (name) => `Unregister ${name}`,
  removeTitle: "Unregister device?",
  removeConfirm: (name) =>
    `“${name}” will no longer receive notifications. They can be enabled again on that device.`,
  registeredAt: (time) => `Registered ${time}`,
  deliveredAt: (time) => `last delivered ${time}`,
  noDevices: "No devices registered.",
  lastFailure: "Last delivery error",
};
