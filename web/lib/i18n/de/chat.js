export const chatComposerCopy = {
  requestPending: "Anfragen prüfen oder im Terminal fortsetzen.",
  messageSent: "An die laufende Sitzung gesendet",
  touchSendHint: "Enter: neue Zeile · Senden über den Button",
};
export const chatAttachmentsCopy = {
  attachAriaLabel: "Datei hinzufügen",
  choose: "Dateien auswählen",
  uploadFailed: "Die Datei konnte nicht hochgeladen werden.",
  attachButton: "Datei hinzufügen",
  dropHint: "Dateien hier ablegen",
  removeAriaLabel: (name) => `Anhang entfernen: ${name}`,
  listAriaLabel: "Anhänge",
  uploading: "Datei wird hochgeladen …",
  unsupportedSession: "Anhänge sind in dieser Sitzung nicht verfügbar.",
  tooManyFiles: "Es sind höchstens 8 Anhänge pro Nachricht möglich.",
  notAnImage: "Nur Bilddateien können angehängt werden.",
  fileTooLarge: "Dateien dürfen höchstens 10 MiB groß sein.",
};
export const chatImagesCopy = {
  chatImageDialogAriaLabel: "Bildansicht",
  chatImageDialogContentAriaLabel: "Bildansicht schließen",
  missingImage: "Bild nicht mehr verfügbar.",
  chatImageOpenAriaLabel: (value1) => `Bild öffnen: ${value1}`,
  unavailableImage: "Bild nicht verfügbar",
  chatImageUnavailableHint: "Die Bilddatei konnte nicht geladen werden.",
  chatImageExpand: "Vergrößern ↗",
  chatImageRetry: "Bild erneut laden",
  chatImagesAriaLabel: "Bilder in der Nachricht",
};
export const chatMessageCopy = {
  oldNoNewline: "Kein abschließender Zeilenumbruch im vorherigen Inhalt",
  newNoNewline: "Kein abschließender Zeilenumbruch im neuen Inhalt",
  changeCreate: "Erstellen",
  changeUpdate: "Ändern",
  changeDelete: "Löschen",
  changeRename: "Umbenennen",
  changeWrite: "Schreiben",
  changeFull: "Dateiinhalt",
  changePatch: "Original-Patch",
  changeExcerpt: "Ersetzungsausschnitt",
  changePreview: "Inhaltsvorschau · vorheriger Inhalt unbekannt",
  changeRaw: "Rohe Argumente und Ausgabe",
  changeCode: "Codeänderungen",
  expandOutput: "Weitere Zeilen anzeigen",
  moreOutput: "Mehr anzeigen",
  collapseOutput: "Auf acht Zeilen kürzen",

  agentWorking: "Agent arbeitet",
  agentActivity: "Agent-Aktivität",
  toolCount: (count) => `${count} ${count === 1 ? "Aufruf" : "Aufrufe"}`,
  toolFailures: (count) => `${count} fehlgeschlagen`,
  chatToolLabel: "Tool-Aktivität",
  ariaLabel: "Deine Nachricht",
  subtle: "[Bild",
};
export const chatViewCopy = {
  historyOlder: "Ältere Nachrichten laden",
  historyLoading: "Ältere Nachrichten werden geladen …",
  historyRetry: "Ältere Nachrichten erneut laden",
  historyFailed: "Ältere Nachrichten konnten nicht geladen werden.",

  chatMainAriaLabel: "Chat",
  hideTasks: "Aufgaben ausblenden",
  showTasks: "Aufgaben einblenden",
  tasksToggle: "☷ Aufgaben",
  changeConversation: "Verlauf wechseln",
  terminalFallback: "Terminal ↗",
  terminalApprovals: "Freigaben im Terminal ↗",
  chatEmptyHeading: "Raum für deine nächste Idee.",
  emptyConversationPrefix: "Deine Nachrichten und die Antworten von",
  emptyConversationSuffix: " erscheinen hier.",
  chatNotice: "Unterhaltung wird geladen …",
};
export const conversationPickerCopy = {
  conversationScopeDescription:
    "Wähle die Unterhaltung, die in dieser Sitzung läuft. Angezeigt werden nur Verläufe dieses Accounts im selben Projekt.",
  conversationPickerOption: "Verläufe werden geladen …",
  noConversationsDescription:
    "Noch kein Verlauf vorhanden. Nach der ersten Nachricht kannst du die Liste aktualisieren.",
};
export const taskPanelCopy = {
  taskHeadingAriaLabel: "Aufgaben schließen",
  contentAriaLabel: "Aufgabenfortschritt",
  tasksEmpty: "Das CLI hat noch keine Aufgaben angelegt.",
};
export const chatAttachmentCopy = {
  attachments: "Anhänge",
  choose: "Dateien auswählen",
  add: "Datei hinzufügen",
  uploading: "Datei wird hochgeladen …",
  remove: (name) => `Anhang entfernen: ${name}`,
  tooLarge: "Eine Datei darf höchstens 10 MB groß sein.",
  tooMany: "Pro Nachricht sind höchstens 10 Anhänge möglich.",
  failed: "Die Datei konnte nicht hochgeladen werden.",
  tooLong: "Die Nachricht mit Anhängen ist zu lang. Bitte kürze den Text.",
  prompt: "Bitte berücksichtige diese angehängten Dateien:",
};

export const chatDeliveryCopy = {
  savedNotices: (count) => `Gespeicherte Zustellungsanzeigen (${count})`,
  savedNoticesHint:
    "Diese gespeicherten Anzeigen dokumentieren die Übergabe an die Sitzung. Sie bestätigen keine Bearbeitung und stehen getrennt vom Gesprächsverlauf.",
  ariaLabel: "Nachrichtenzustellung",
  waiting: "Wartet auf Übergabe",
  absent: "Wartet auf Übergabe · noch nicht beim Server angenommen",
  sending: "Wird übergeben …",
  checking: "Zustellung wird geprüft …",
  pending: "Übergabe läuft …",
  "handed-off": "An Sitzung übergeben · Bearbeitungsbeginn noch nicht bestätigt",
  uncertain: "Zustellung unklar",
  rejected: "Nicht zugestellt",
  uncertainHint:
    "Neu zustellen prüft zuerst die TUI-Eingabe. Bei unklarem Zustand wird nichts erneut geschrieben.",
  disconnected: "Keine Bestätigung erhalten. Die Nachricht bleibt gespeichert.",
  recovering: "Wird geprüft …",
  redeliver: "Neu zustellen",
  inspect: "Übergabe prüfen",
  openTerminal: "TUI öffnen",
  retry: "Übergabe erneut versuchen",
  check: "Zustellung prüfen",
  restore: "Nach Prüfung als Entwurf übernehmen",
  edit: "Nachricht bearbeiten",
  dismiss: "Zustellungsanzeige schließen",
  prepareFailed:
    "Die Nachricht konnte nicht vorbereitet werden. Bitte Browser aktualisieren und erneut versuchen; der Entwurf bleibt erhalten.",
  lockUnavailable:
    "Dieser Browser unterstützt die sichere Zustellungsverwaltung nicht. Bitte aktualisiere den Browser.",
  storageFailed:
    "Der lokale Entwurfs- oder Zustellungsstand konnte nicht gespeichert werden. Bitte Speicher freigeben; ausstehende Nachrichten bleiben zur Prüfung sichtbar.",
  storageUnreadable:
    "Gespeicherter Entwurf ist nicht lesbar. Er wurde nicht überschrieben; Senden bleibt gesperrt.",
  timeout:
    "Keine rechtzeitige Bestätigung. Die Zustellung wird beim Wiederverbinden geprüft.",
};
