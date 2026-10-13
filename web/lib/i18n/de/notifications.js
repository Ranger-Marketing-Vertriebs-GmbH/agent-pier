export const notificationCopy = {
  title: "App & Benachrichtigungen",
  description:
    "AgentPier installieren und Hinweise auf diesem Gerät ausdrücklich aktivieren.",
  installTitle: "AgentPier als App",
  install: "App installieren",
  installed: "AgentPier läuft bereits als installierte App.",
  installHelp:
    "Im Browsermenü „App installieren“ oder „Zum Home-Bildschirm“ wählen. Auf iPhone und iPad stehen Push-Mitteilungen ab iOS 16.4 in der installierten Home-Bildschirm-App zur Verfügung.",
  offlinePrivacy:
    "Offline erscheint nur ein öffentlicher Hinweis. Sitzungen, Chats, API-Antworten und Zugangsdaten werden nicht für die Offline-Nutzung gespeichert.",
  pushTitle: "Benachrichtigungen auf diesem Gerät",
  pushPrivacy:
    "Hinweise enthalten nur den Ereignistyp. Aufgaben, Befehle und Chat-Inhalte bleiben privat. Ein Hinweis öffnet die betreffende Ansicht; er genehmigt keine Aktion.",
  unsupported:
    "Dieser Browser unterstützt hier keine Push-Mitteilungen. Eine sichere HTTPS-Verbindung oder localhost und ein unterstützter Browser sind erforderlich.",
  denied:
    "Benachrichtigungen sind im Browser gesperrt. Ändere die Website-Berechtigung in den Browsereinstellungen und lade diese Ansicht erneut.",
  appGroup: "App",
  installedStatus: "Installiert",
  notInstalled: "Läuft im Browser.",
  pushToggle: "Benachrichtigungen",
  deviceLabel: "Gerätename",
  saveName: "Namen speichern",
  thisDevice: "Dieses Gerät",
  unnamedDevice: "Unbenanntes Gerät",
  deviceName: (browser, platform, app) =>
    `${browser || "Browser"}${platform ? ` auf ${platform}` : ""}${app ? " (App)" : ""}`,
  active: "Auf diesem Gerät aktiviert.",
  inactive: "Auf diesem Gerät nicht aktiviert.",
  incomplete: "Nicht vollständig aktiviert. Aus- und wieder einschalten.",
  test: "Testbenachrichtigung senden",
  sent: "Testbenachrichtigung versendet.",
  testFailed: "Die Testbenachrichtigung konnte nicht versendet werden.",
  permissionRequired: "Die Browser-Berechtigung wurde nicht erteilt.",
  storageFailed:
    "Die Gerätekennung konnte nicht gespeichert werden. Erlaube lokalen Website-Speicher und versuche es erneut.",
  unsubscribeFailed:
    "Die Server-Anmeldung wurde entfernt. Die Browser-Anmeldung konnte noch nicht entfernt werden. Bitte erneut versuchen.",
  loading: "Einstellungen werden geladen …",
  unavailable: "Benachrichtigungen sind auf diesem Server nicht verfügbar.",
  devices: "Angemeldete Geräte",
  remove: "Abmelden",
  removeNamed: (name) => `${name} abmelden`,
  removeTitle: "Gerät abmelden?",
  removeConfirm: (name) =>
    `„${name}“ erhält danach keine Benachrichtigungen mehr. Auf dem Gerät selbst lassen sie sich wieder aktivieren.`,
  registeredAt: (time) => `Angemeldet ${time}`,
  deliveredAt: (time) => `zuletzt zugestellt ${time}`,
  noDevices: "Keine Geräte angemeldet.",
  lastFailure: "Letzter Zustellfehler",
};
