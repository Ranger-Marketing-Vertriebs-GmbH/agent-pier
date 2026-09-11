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
};
