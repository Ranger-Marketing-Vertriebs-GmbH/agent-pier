/** Existing German product copy, addressed through English semantic keys. */
export const accounts = Object.freeze({
  waitForPluginOperation: "Bitte die laufende Plugin-Verwaltung abwarten.",
  stopBeforeKeyChange:
    "Bitte vor einem Key-Wechsel die Sessions dieses Accounts beenden.",
  stopBeforeDelete: "Bitte zuerst die Sessions dieses Accounts beenden.",
  localAccountName: (toolName) => `${toolName} · Lokal`,
  notFound: "Account nicht gefunden.",
  localProfileReadOnly: "Das lokale Profil wird hier nicht verändert.",
  invalidApiKey: "Ungültiger API-Key.",
  invalidLaunchMode: "Ungültiger Startmodus für dieses CLI-Tool.",
  launchModeRequiresWorkSession:
    "Startmodi gelten nur für neue Arbeitssitzungen, nicht für die Anmeldung.",
  managedLoginRequired: "Bitte einen separaten Account für die Anmeldung anlegen.",
  apiKeyLoginConflict:
    "Dieses Profil verwendet einen API-Key. Für die Browser-Anmeldung bitte ein Konto ohne API-Key anlegen.",
  cliNotInstalled: (toolName) => `${toolName} ist nicht installiert.`,
  supportedShellUnavailable: "Keine unterstützte lokale Shell verfügbar.",
});
