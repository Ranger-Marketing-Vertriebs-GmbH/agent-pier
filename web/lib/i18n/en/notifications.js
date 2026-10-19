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
    "You choose per device what notifications show. They never contain commands, paths, links or secrets. A notification opens the relevant view; it does not approve any action.",
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
  deviceSettings: "Settings",
  deviceSettingsNamed: (name) => `Notification settings for ${name}`,
  preferencesTitle: (name) => `Notifications on ${name}`,
  levelGroup: "Detail level",
  levelHint:
    "Others can see the lock screen. Notifications are encrypted in transit but appear in plain text on the device.",
  levels: {
    type: {
      label: "Event type only",
      sub: "“Question: A session is waiting for your answer.” For shared devices.",
    },
    label: {
      label: "With names",
      sub: "Session, agent or pipeline name, CLI and project. No content.",
    },
    preview: {
      label: "With preview",
      sub: "Also up to 140 characters of a question, a reply, a check-in or a team goal. Never commands, paths or secrets; approvals never show a preview.",
    },
  },
  eventsGroup: "Events",
  eventGroups: { waiting: "Waiting for you", finished: "Finished", agents: "Agents" },
  events: {
    question: "Question from a CLI",
    permission: "Approval for a CLI",
    "session-waiting": "Session waiting in the terminal",
    "pipeline-gate": "Pipeline waiting at a gate",
    "agent-approval": "Agent approval (shell, SSH, tasks, team proposals)",
    "session-completed": "Response ready",
    "session-ended": "Session ended",
    "pipeline-completed": "Pipeline completed",
    "pipeline-failed": "Pipeline failed",
    "agent-checkin": "Agent check-in",
    "agent-routine": "Routine result",
    telegram: "Also what Telegram delivered",
  },
  telegramSub:
    "Check-ins and routine results that also reached the agent's paired Telegram chat.",
  systemNote:
    "Delivery problems, Telegram access, GitHub tokens and low disk space always notify.",
  behaviourGroup: "Grouping and quiet",
  grouping: "Group by session, agent or run",
  groupingSub:
    "A new notification replaces the older one from the same source instead of stacking.",
  quietHours: "Quiet hours",
  quietHoursSub: (zone) =>
    `The server holds notifications back instead of just muting them. Times in ${zone}.`,
  hostTimeZone: "the server's time zone",
  quietFrom: "From",
  quietTo: "To",
  blockingThrough: "Let questions and approvals through",
  blockingThroughSub:
    "Questions, approvals and gates that wait for you arrive during quiet hours too.",
  visibleNote:
    "Nothing is sent while the inbox or the same session, agent chat or run is open on one of your devices.",
  labelOffer: "Show names in notifications?",
  labelOfferSub:
    "Session, agent and pipeline names appear on this device's lock screen. Content stays private.",
  labelOfferAccept: "Show names",
  labelOfferDismiss: "Not now",
};
