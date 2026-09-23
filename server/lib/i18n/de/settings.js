/** Existing German product copy, addressed through English semantic keys. */
export const settings = Object.freeze({
  invalidSavedPreferences: "Gespeicherte Einstellungen sind ungültig.",
  invalidPreferences: "Ungültige Einstellungen.",
  invalidNetworkConfig:
    "Ungültige Netzwerk-Konfiguration: Bind-Adresse muss 0.0.0.0 oder :: sein, Hosts sind Namen oder IPs ohne Schema, Pfad oder Port (maximal 20).",
  networkLocked:
    "Über den Netzwerkzugriff kann der Netzwerkmodus nur ausgeschaltet werden. Bind-Adresse und Hostliste lokal oder über Tailscale ändern.",
  restartFailed:
    "Der Dienst konnte nicht neu gestartet werden. Bitte manuell neu starten: npm run service:install oder npm start.",
  invalidDefaultAccounts: "Ungültige Auswahl der Standard-Accounts.",
  defaultAccountRequiresCodingCli: "Standard-Accounts erfordern ein Coding-CLI.",
  nativeDefaultAccountRequired:
    "Bitte einen vorhandenen nativen Account für das gewählte CLI wählen.",
});
