export const chatComposerCopy = {
  requestPending:
    "Beantworte die offene Anfrage oben oder im Terminal. Jetzt gesendete Nachrichten werden danach zugestellt.",
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
  toolDetails: "Details",
  ariaLabel: "Deine Nachricht",
  subtle: "[Bild",
};
export const chatViewCopy = {
  jumpToLatest: "Zur neuesten Nachricht",
  resetRequested: "Neue Unterhaltung angefordert",
  resetConfirmed: "Neue Unterhaltung bereit",
  resetPrevious: "Bisherige Unterhaltung",
  resetPendingHint:
    "Wir warten auf die Bestätigung der neuen Unterhaltung durch Codex. Dein bisheriger Verlauf bleibt unten verfügbar.",
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
  nativeQueued: "In der CLI-Warteschlange",
  nativeAccepted: "Von der CLI übernommen",
  nativeCodexQueueHint:
    "Codex zeigt diese Nachricht für die Übergabe nach dem nächsten Tool-Aufruf an.",
  nativeQueueHint: "Die CLI zeigt diese Nachricht als wartend an.",

  savedNotices: (count) => `Gespeicherte Zustellungsanzeigen (${count})`,
  savedNoticesHint:
    "Diese gespeicherten Anzeigen dokumentieren die Übergabe an die Sitzung. Sie bestätigen keine Bearbeitung und stehen getrennt vom Gesprächsverlauf.",
  ariaLabel: "Nachrichtenzustellung",
  waiting: "Wartet auf Übergabe",
  absent: "Wartet auf Übergabe · noch nicht beim Server angenommen",
  sending: "Wird übergeben …",
  checking: "Zustellung wird geprüft …",
  pending: "Übergabe läuft …",
  "handed-off": "An TUI gesendet · CLI-Bestätigung steht aus",
  uncertain: "Zustellung unklar",
  waitingRequest:
    "Wartet auf die Antwort zur offenen Anfrage · wird danach automatisch gesendet",
  waitingDialog:
    "Wartet auf einen Dialog in der TUI · wird automatisch gesendet, sobald er beantwortet oder geschlossen ist",
  waitingQueue:
    "Wartet hinter einer früheren Nachricht · wird danach automatisch gesendet",
  cancel: "Senden abbrechen",
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
  absentHint:
    "Der Server hat diese Nachricht nicht angenommen. Du kannst sie bearbeiten oder erneut übergeben.",
  // The same reasons after the text was pasted but before Enter (uncertain).
  imagesPasted:
    "Die angehängten Bilder stehen im Eingabefeld der TUI, die Nachricht wurde aber nicht vervollständigt und nicht abgeschickt. Bitte prüfe die TUI, bevor du erneut sendest.",
  // The same reasons with only the image chips in the prompt (images-pasted).
  imagesPastedReasons: {
    CHAT_PROMPT_CHANGED:
      "Die angehängten Bilder wurden in Claude eingefügt, aber das Eingabefeld hat sich während des Wartens verändert. Die Nachricht wurde deshalb nicht vervollständigt und nicht abgeschickt; bitte prüfe die TUI.",
    CHAT_DIALOG_NOT_CLOSED:
      "Die angehängten Bilder stehen im Eingabefeld der TUI, die Nachricht wurde aber nicht vervollständigt und nicht abgeschickt: Ein Claude-Menü ließ sich nicht schließen. Bitte prüfe die TUI, bevor du erneut sendest.",
    CHAT_QUESTION_OPEN:
      "Die angehängten Bilder stehen im Eingabefeld der TUI, die Nachricht wurde aber nicht vervollständigt und nicht abgeschickt: Claude wartet auf die Antwort zu einer Frage. Bitte prüfe die TUI, bevor du erneut sendest.",
    CHAT_REQUEST_PENDING:
      "Die angehängten Bilder stehen im Eingabefeld der TUI, die Nachricht wurde aber nicht vervollständigt und nicht abgeschickt: Eine Anfrage wartet auf Antwort. Bitte prüfe die TUI, bevor du erneut sendest.",
  },
  pastedReasons: {
    CHAT_PROMPT_CHANGED:
      "Die Nachricht wurde in Claude eingefügt, aber das Eingabefeld hat sich während des Wartens verändert. Sie wurde deshalb nicht abgeschickt; bitte prüfe die TUI.",
    CHAT_DIALOG_NOT_CLOSED:
      "Die Nachricht steht im Eingabefeld der TUI, wurde aber nicht abgeschickt: Ein Claude-Menü ließ sich nicht schließen. Bitte prüfe die TUI, bevor du erneut sendest.",
    CHAT_QUESTION_OPEN:
      "Die Nachricht steht im Eingabefeld der TUI, wurde aber nicht abgeschickt: Claude wartet auf die Antwort zu einer Frage. Bitte prüfe die TUI, bevor du erneut sendest.",
    CHAT_REQUEST_PENDING:
      "Die Nachricht steht im Eingabefeld der TUI, wurde aber nicht abgeschickt: Eine Anfrage wartet auf Antwort. Bitte prüfe die TUI, bevor du erneut sendest.",
    CHAT_COMPOSER_DIALOG:
      "Die Nachricht wurde in Claude eingefügt, aber nicht abgeschickt: Claude zeigt einen Dialog. Bitte prüfe die TUI, bevor du erneut sendest.",
    CHAT_COMPOSER_UNAVAILABLE:
      "Die Nachricht wurde in Claude eingefügt, aber nicht abgeschickt: Das Eingabefeld ist nicht sicher erkennbar. Bitte prüfe die TUI.",
    CHAT_COMPOSER_NOT_CLEARED:
      "Die Nachricht wurde in Claude eingefügt, aber nicht abgeschickt. Bitte prüfe die TUI, bevor du erneut sendest.",
    CHAT_IMAGES_UNCONFIRMED:
      "Die Nachricht wurde in Claude eingefügt, aber nicht abgeschickt: Claude zeigt nicht alle angehängten Bilder im Eingabefeld an. Vergrößere das Terminal oder prüfe die TUI, bevor du erneut sendest.",
  },
  // Informational, non-blocking notes on a completed handoff.
  notices: {
    CHAT_APPENDED_TO_DRAFT:
      "Zusammen mit Text gesendet, der bereits im Terminal-Eingabefeld stand.",
    CHAT_PROMPT_UNREADABLE:
      "Das Terminal-Eingabefeld war nicht lesbar; die Nachricht wurde zusammen mit einem eventuell vorhandenen Inhalt gesendet.",
    CHAT_DIALOG_CLOSED:
      "Ein offenes Claude-Menü (z. B. Zurückspulen oder Modellauswahl) wurde vor dem Senden mit Esc geschlossen.",
    CHAT_IMAGES_MAYBE_MISSING:
      "Claude hat vor dem Senden nicht alle angehängten Bilder angezeigt; einzelne Bilder fehlen möglicherweise.",
  },
  reasons: {
    CHAT_PROMPT_CHANGED:
      "Die Nachricht wurde in Claude eingefügt, aber das Eingabefeld hat sich während des Wartens verändert. Sie wurde deshalb nicht abgeschickt; bitte prüfe die TUI.",
    CHAT_QUEUED:
      "Die Nachricht wartete hinter einer früheren Nachricht und wurde noch nicht eingegeben. Sende sie erneut.",
    CHAT_CANCELLED: "Abgebrochen, bevor die Nachricht in die TUI eingegeben wurde.",
    CHAT_DIALOG_NOT_CLOSED:
      "Die Nachricht wartete darauf, dass sich ein Claude-Menü schließt, und wurde noch nicht eingegeben. Schließe das Menü im Terminal und sende sie dann erneut.",
    CHAT_QUESTION_OPEN:
      "Die Nachricht wartete auf die Antwort zu einer Frage in der TUI und wurde noch nicht eingegeben. Beantworte die Frage im Terminal und sende sie dann erneut.",
    CHAT_REQUEST_PENDING:
      "Die Nachricht wartete auf die Antwort zu einer offenen Anfrage und wurde noch nicht eingegeben. Sende sie erneut, sobald die Anfrage beantwortet ist.",
    CHAT_COMPOSER_DIALOG:
      "Claude zeigt gerade einen Dialog oder eine Auswahl. Die Nachricht wurde nicht gesendet; bitte beantworte oder schließe den Dialog in der TUI.",
    CHAT_COMPOSER_UNAVAILABLE:
      "Das Claude-Eingabefeld ist nicht sicher erkennbar. Die Nachricht wurde nicht gesendet; bitte prüfe die TUI.",
    CHAT_COMPOSER_NOT_CLEARED:
      "Der vorhandene Entwurf im Claude-Eingabefeld konnte nicht sicher ersetzt werden. Die Nachricht wurde nicht gesendet; bitte prüfe die TUI.",
    CHAT_SUBMIT_UNCONFIRMED:
      "Claude hat die Übernahme der Nachricht nicht bestätigt. Bitte prüfe die TUI, bevor du erneut sendest.",
    CHAT_IMAGES_UNCONFIRMED:
      "Claude hat nicht bestätigt, dass alle angehängten Bilder übernommen wurden. Bitte prüfe die TUI, bevor du erneut sendest.",
  },
};
