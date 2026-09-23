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
  rejected:
    "Die Eingabe wurde vor der Terminal-Übergabe abgelehnt. Bitte prüfe die Sitzung und offene Freigaben.",
  uncertain:
    "Die Terminal-Übergabe ist unklar. Erneutes Senden kann die Eingabe duplizieren.",
  // The same reasons after the text was pasted but before Enter (uncertain).
  pastedReasons: {
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
  reasons: {
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
