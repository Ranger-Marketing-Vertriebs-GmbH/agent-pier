export const autopilot = Object.freeze({
  orderNotFound: "Dieser Autopilot-Auftrag wurde nicht gefunden.",
  projectUnavailable: "Öffne ein registriertes lokales Git-Projekt für diesen Auftrag.",
  unsafeOrderFile:
    "Der Speicherort des Composer-Auftrags hat sich geändert oder ist unsicher.",
  orderFileUnavailable: "Stelle die ursprüngliche Composer-Auftragsdatei wieder her.",
  requestConflict:
    "Diese Anfragekennung gehört bereits zu einem anderen Auftrag oder anderen Startoptionen.",
  requestRemoved: "Der mit dieser Anfrage angelegte Auftrag wurde bereits entfernt.",
  cleanupUnavailable:
    "Nur abgeschlossene, von AgentPier verwaltete Aufträge ohne offene Arbeit können entfernt werden.",
  invalidOrder: "Prüfe die Felder des Autopilot-Auftrags.",
  selectionRequired:
    "Wähle eine Coding-CLI oder einen CLI-Account für die Composer-Session.",
  composerSkillUnavailable:
    "Installiere die aktuelle mitgelieferte Version von agentpier-composer im ausgewählten CLI-Profil.",
  sessionRecoveryRequired:
    "Die zugeordnete Composer-Session fehlt. Stelle die Session aus dem gespeicherten Auftrag wieder her.",
  sessionUnavailable:
    "Prüfe den Zustand der Composer-Session und setze sie über die Session-Ansicht fort.",
  worktreeBusy:
    "Beende aktive Sessions, Prozesse und Läufe im Composer-Worktree vor dem Entfernen.",
  worktreeDirty:
    "Sichere lokale Änderungen und zusätzliche Dateien im Composer-Worktree vor dem Entfernen.",
  worktreeUnmerged: "Der Composer-Branch enthält Commits, die im Basisbranch fehlen.",
  ownershipMismatch:
    "Die gespeicherten Eigentumsdaten stimmen nicht mit dem Composer-Worktree oder der Session überein.",
  deliveryFailed:
    "Prüfe die Nachrichtenzustellung in der Composer-Session und wiederhole den Vorgang.",
  unmanaged: "Für diesen Auftrag ist keine von AgentPier verwaltete Session registriert.",
  executionUnavailable:
    "Setze diesen Auftrag fort und gib die Umsetzung frei, bevor du eine weitere Pipeline startest.",
  inactive: "Dieser Auftrag ist abgeschlossen oder wird gerade entfernt.",
});
