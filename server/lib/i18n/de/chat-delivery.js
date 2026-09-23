export const chatDeliveryCopy = {
  recoveryUncertain:
    "Es ist nicht sicher erkennbar, ob die Nachricht bereits abgeschickt wurde. Bitte prüfe die TUI.",
  recoveryLimit:
    "Zu viele Wiederherstellungsversuche für diese Nachricht. Bitte prüfe die TUI.",
  recoveryPending: "Ein Übergabeversuch läuft bereits.",
  recoveryChanged:
    "Der Zustellungsstand hat sich inzwischen geändert. Bitte aktualisiere den Status.",
  recoveryRuntime:
    "Die ursprüngliche CLI-Sitzung ist nicht mehr eindeutig zugeordnet. Bitte prüfe die TUI.",
  recoveryComposer:
    "Die TUI-Eingabe enthält anderen Text oder ist nicht vollständig lesbar. Sie wurde nicht verändert.",
  recoveryReadySubmit:
    "Der vollständige Text steht noch in der TUI. Mit Neu zustellen wird nur das Abschicken nachgeholt.",
  recoveryReadyResend:
    "Die Nachricht wurde noch nicht geschrieben und kann neu zugestellt werden.",
  recoveryHandedOff: "Die Nachricht wurde an die TUI übergeben.",
  invalid: "Ungültiger Zustellauftrag.",
  scope: "Der Zustellauftrag gehört nicht zur aktuellen Sitzung.",
  conflict: "Diese Zustell-ID wurde bereits für einen anderen Auftrag verwendet.",
  storage: "Der Zustellbeleg kann nicht sicher gespeichert oder gelesen werden.",
  cancelPasted:
    "Die Nachricht steht bereits im Eingabefeld der TUI. Entferne oder sende sie dort.",
  recoveryHeld: "Die Nachricht wartet und wird zugestellt, sobald die TUI frei ist.",
  rejected:
    "Die Eingabe wurde vor der Terminal-Übergabe abgelehnt. Bitte prüfe die Sitzung und offene Freigaben.",
  uncertain:
    "Die Terminal-Übergabe ist unklar. Erneutes Senden kann die Eingabe duplizieren.",
  // The same reasons after the text was pasted but before Enter (uncertain).
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
  // Stable reason identifiers; the browser translates them by code.
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
