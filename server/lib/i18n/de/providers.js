/** German browser-visible server messages, addressed through English semantic keys. */
export const providers = Object.freeze({
  invalidAccessSelection: "Ungültige Zugriffsauswahl für die Sitzung.",
  nativeOrProviderModel:
    "Bitte entweder ein natives Modell oder ein Provider-Modell wählen.",
  connectionRequiredForModel:
    "Bitte für das Provider-Modell eine Provider-Verbindung wählen.",
  nativeAccountToolMismatch: "Der native Account gehört nicht zum gewählten CLI.",
  connectionRequiresWorkSession:
    "Provider-Verbindungen benötigen eine Coding-Arbeitssitzung.",
  apiKeyRequiredForSession:
    "Bitte vor dem Start dieser Sitzung einen Provider-API-Key hinterlegen.",
  apiKeyRequiredForAccount:
    "Bitte vor dem Start dieses Accounts einen Provider-API-Key hinterlegen.",
  connectionToolUnsupported:
    "Diese Verbindung unterstützt das gewählte CLI nicht oder hat keinen angegebenen Zugriff auf die Responses API.",
  invalidModelId: "Ungültige Modell-ID.",
  modelNotInCatalog:
    "Das Modell ist nicht im unterstützten Provider-Katalog. Bitte den Katalog aktualisieren oder ein anderes Modell wählen.",
  catalogRefreshFailed:
    "Die Katalogaktualisierung ist fehlgeschlagen; der bisherige Katalog bleibt verfügbar.",
  invalidConnectionFields: "Ungültige Angaben für die Provider-Verbindung.",
  invalidApiKey: "Ungültiger Provider-API-Key.",
  invalidKeyRemoval: "Ungültige Auswahl zum Entfernen des Keys.",
  responsesAccessBoolean:
    "Der Zugriff auf die Responses API muss ausdrücklich als Wahrheitswert angegeben werden.",
  connectionNotFound: "Provider-Verbindung nicht gefunden.",
  connectionPreparingSession:
    "Mit dieser Verbindung wird gerade eine Sitzung vorbereitet. Bitte nach dem Sitzungsstart erneut versuchen.",
  responsesEntitlementZaiOnly:
    "Die Responses-Berechtigung gilt nur für Z.ai-Verbindungen.",
  unknownProvider: "Unbekannter Provider.",
  invalidProviderSelection:
    "Ungültige Provider-Auswahl. Modellgrenzen ermittelt der Server.",
  providerToolUnsupported: "Dieser Provider unterstützt das gewählte CLI nicht.",
  zaiCodexRequiresResponses:
    "Z.ai mit Codex erfordert ein Konto mit Zugriff auf die Responses API. Reine Chat-Konten werden nicht unterstützt.",
  responsesAccessZaiCodexOnly: "Der Responses-Zugriff gilt nur für Z.ai mit Codex.",
  claudeVersionUnverified:
    "Die Version von Claude Code konnte nicht geprüft werden. Bitte den Start wiederholen; falls das Problem bleibt, prüfen, ob das CLI auf --version antwortet.",
  claudeVersionTooOld:
    "Eine eigene Kontextkonfiguration für Modelle erfordert Claude Code 2.1.193 oder neuer. Bitte das CLI vor dem Start dieses Modells aktualisieren.",
  contextLimitUnverified:
    "Für dieses Modell ist keine geprüfte Kontextgrenze bekannt. Bitte den Katalog aktualisieren, bevor es in Claude Code gestartet wird.",
  managedConfigInvalid:
    "Die verwaltete Provider-Konfiguration ist ungültig. Bitte vor dem Start reparieren.",
  managedOpenCodeConfigInvalid:
    "Die verwaltete OpenCode-Konfiguration ist ungültig. Bitte vor dem Start reparieren.",
});
