export const connectionCopy = {
  title: "Zentrale Provider-Zugänge",
  description:
    "Einen API-Key pro Provider-Zugang speichern und mit kompatiblen CLIs verwenden. CLI, Modell und Startmodus wählst du für jede Sitzung.",
  add: "Provider-Zugang hinzufügen",
  edit: "Provider-Zugang bearbeiten",
  name: "Name des Zugangs",
  key: "API-Key",
  save: "Zugang speichern",
  provider: "API-Anbieter",
  loading: "Anbieter werden geladen …",
  empty: "Noch keine zentralen Provider-Zugänge.",
  native: "Native CLI-Konten",
  legacy: "Bestehende Anbieterbindung · nur für diese CLI",
  legacyHelp:
    "Diese ältere Anbieterbindung bleibt bearbeitbar. Neue gemeinsame API-Zugänge verwaltest du unter „Zentrale Provider-Zugänge“.",
  providerNames: {
    openrouter: "OpenRouter",
    zai: "Z.ai API",
    "zai-coding-plan": "Z.ai Coding Plan",
  },
  keySaved: "API-Key gespeichert",
  keyMissing: "API-Key fehlt",
  keyPlaceholder: "Leer lassen, um den gespeicherten Key zu behalten",
  keyOptional: "Kann auch später ergänzt werden",
  keyHelp:
    "Der Key wird zentral gespeichert. Änderungen gelten für neue Sitzungen; laufende native Prozesse werden nicht beendet.",
  removeKey: "Gespeicherten API-Key entfernen",
  editNamed: (name) => `${name} bearbeiten`,
  deleteNamed: (name) => `${name} löschen`,
  delete: "Zugang löschen",
  deleteConfirm: (name) =>
    `Provider-Zugang „${name}“ und seinen gespeicherten Key löschen? Neue Sitzungen können diesen Zugang dann nicht mehr verwenden. Bestehende Sitzungen und ihre Verläufe bleiben erhalten.`,
  responses: "Responses-API-Zugang bestätigt",
  responsesHelp:
    "Mein Z.ai-Zugang erlaubt die Responses API für Codex. Diese Angabe ist eine eigene Bestätigung und keine automatische Prüfung.",
  compatible: "Kompatible CLIs",
  noCompatible: "Keine kompatible CLI verfügbar",
  accountDescription:
    "Native Anmeldungen bleiben an ihre jeweilige CLI gebunden. Zentrale API-Zugänge werden getrennt davon verwaltet.",
  cli: "CLI",
  access: "Zugang",
  nativeModel: "Natives Modell (optional)",
  nativeModelHelp:
    "Leer lassen für die CLI-Voreinstellung oder eine exakte native Modell-ID eingeben. Die verfügbare Modellauswahl kannst du auch in der laufenden Sitzung öffnen.",
  nativeDefault: "CLI-Voreinstellung",
  noAccess: "Kein kompatibler Zugang",
  isolated:
    "Dieser Provider-Zugang verwendet ein eigenes CLI-Profil. Anmeldungen, MCP-Konfiguration und Plugins nativer Konten werden nicht übernommen.",
  legacyLaunch:
    "Diese bestehende Anbieterbindung verwendet ihr gespeichertes Modell. Für eine unabhängige Modellwahl einen zentralen Provider-Zugang verwenden.",
  chooseAccess: "Bitte einen kompatiblen Zugang und ein verfügbares Modell wählen.",
  directoryPlaceholder: "/Pfad/zum/Projekt",
};
