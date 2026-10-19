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
    "Offline erscheint nur ein öffentlicher Hinweis. Sessions, Chats, API-Antworten und Zugangsdaten werden nicht für die Offline-Nutzung gespeichert.",
  pushTitle: "Benachrichtigungen auf diesem Gerät",
  pushPrivacy:
    "Was Hinweise zeigen, legst du pro Gerät fest. Sie enthalten nie Befehle, Pfade, Links oder Geheimnisse. Ein Hinweis öffnet die betreffende Ansicht; er genehmigt keine Aktion.",
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
  deviceSettings: "Einstellungen",
  deviceSettingsNamed: (name) => `Benachrichtigungseinstellungen für ${name}`,
  preferencesTitle: (name) => `Benachrichtigungen auf ${name}`,
  levelGroup: "Detailstufe",
  levelHint:
    "Den Sperrbildschirm können andere sehen. Hinweise sind unterwegs verschlüsselt, erscheinen auf dem Gerät aber im Klartext.",
  levels: {
    type: {
      label: "Nur Ereignistyp",
      sub: "„Rückfrage: Eine Session wartet auf deine Antwort.“ Für geteilte Geräte.",
    },
    label: {
      label: "Mit Namen",
      sub: "Name der Session, des Agenten oder der Pipeline, CLI und Projekt. Keine Inhalte.",
    },
    preview: {
      label: "Mit Vorschau",
      sub: "Zusätzlich bis zu 140 Zeichen aus Rückfrage, Antwort, Check-in oder Team-Ziel. Nie Befehle, Pfade oder Geheimnisse; Freigaben zeigen nie eine Vorschau.",
    },
  },
  eventsGroup: "Ereignisse",
  eventGroups: { waiting: "Wartet auf dich", finished: "Fertig", agents: "Agenten" },
  events: {
    question: "Rückfrage einer CLI",
    permission: "Freigabe für eine CLI",
    "session-waiting": "Session wartet im Terminal",
    "pipeline-gate": "Pipeline wartet an einem Gate",
    "agent-approval":
      "Freigabe für einen Agenten (Shell, SSH, Aufträge, Team-Vorschläge)",
    "session-completed": "Antwort bereit",
    "session-ended": "Session beendet",
    "pipeline-completed": "Pipeline abgeschlossen",
    "pipeline-failed": "Pipeline fehlgeschlagen",
    "agent-checkin": "Agent meldet sich",
    "agent-routine": "Ergebnis einer Routine",
    telegram: "Auch was Telegram schon zugestellt hat",
  },
  telegramSub:
    "Check-ins und Ergebnisse von Routinen, die auch im gekoppelten Telegram-Chat des Agenten ankamen.",
  systemNote:
    "Zustellprobleme, Telegram-Zugang, GitHub-Token und knapper Speicherplatz melden sich immer.",
  behaviourGroup: "Bündeln und Ruhe",
  grouping: "Pro Session, Agent oder Lauf bündeln",
  groupingSub:
    "Ein neuer Hinweis ersetzt den älteren derselben Quelle, statt sich zu stapeln.",
  quietHours: "Ruhezeiten",
  quietHoursSub: (zone) =>
    `Der Server hält Hinweise zurück, statt sie nur stumm zu zeigen. Zeiten in ${zone}.`,
  hostTimeZone: "der Zeitzone des Servers",
  quietFrom: "Von",
  quietTo: "Bis",
  blockingThrough: "Rückfragen und Freigaben trotzdem zustellen",
  blockingThroughSub:
    "Rückfragen, Freigaben und Gates, die auf dich warten, kommen auch in der Ruhezeit.",
  visibleNote:
    "Solange der Eingang oder dieselbe Session, derselbe Agenten-Chat oder Lauf auf einem deiner Geräte offen ist, kommt kein Hinweis.",
  labelOffer: "Namen in Hinweisen zeigen?",
  labelOfferSub:
    "Namen von Sessions, Agenten und Pipelines erscheinen auf dem Sperrbildschirm dieses Geräts. Inhalte bleiben privat.",
  labelOfferAccept: "Namen zeigen",
  labelOfferDismiss: "Nicht jetzt",
};
