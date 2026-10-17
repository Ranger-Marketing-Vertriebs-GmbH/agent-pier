/** Existing German product copy, addressed through English semantic keys. */
export const agentbus = Object.freeze({
  invalidSession: "Ungültige AgentBus-Sitzung.",
  sessionAlreadyExists: "Die AgentBus-Sitzung existiert bereits.",
  codexRegistrationPending:
    "Noch nicht registriert. Falls Codex Hooks zur Prüfung meldet, /hooks öffnen und die AgentBus-Hooks prüfen.",
  nativeRegistrationPending:
    "Die native AgentBus-Erweiterung hat sich noch nicht registriert.",
  overviewNotice:
    "Nur aktivierte AgentPier-Sitzungen im selben Projekt tauschen Nachrichten aus. Diese Übersicht liest keine Nachrichten und markiert nichts als gelesen. Codex kann eine native Prüfung neuer Hooks verlangen.",
  invalidHistoryPage: "Ungültige AgentBus-Verlaufsseite.",
  projectNotFound: "AgentBus-Projekt nicht gefunden.",
  historyScanLimit:
    "Die Ansicht ist auf 5.000 geprüfte Dateien begrenzt; weitere Nachrichten können vorhanden sein.",
  sendBudgetSender: (limit, seconds) =>
    `SEND_BUDGET: Diese Sitzung hat in der letzten Minute bereits ${limit} Nachrichten gesendet. Warte ${seconds} Sekunden, bevor du erneut sendest.`,
  sendBudgetPair: (limit, name) =>
    `SEND_BUDGET: An ${name} wurden in den letzten 10 Minuten bereits ${limit} Nachrichten gesendet. Nicht erneut versuchen; informiere den Nutzer oder warte auf seine Anweisung.`,
  sendBudgetDepth: (limit) =>
    `SEND_BUDGET: Diese Antwortkette hat bereits ${limit} Nachrichten erreicht. Nicht erneut versuchen; informiere den Nutzer oder warte auf seine Anweisung. Beginne einen neuen Verlauf ohne replyTo nur, wenn der Nutzer weitere Abstimmung verlangt hat.`,
});
