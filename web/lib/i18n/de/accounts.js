export const accountDialogCopy = {
  profileIsolationDescription:
    "Ein eigenes Profil hält Anmeldung und Konfiguration getrennt. Du kannst dich anschließend direkt im Terminal anmelden.",
  accountNamePlaceholder: "z. B. Persönlich oder Arbeit",
  toolLabel: "Tool",
  uninstalledToolSuffix: " · nicht installiert",
  apiKeyLabel: "API-Key (optional)",
  savedKeyPlaceholder: "Gespeichert · zum Ersetzen eingeben",
  nativeKeyPlaceholder: "Alternativ zur interaktiven Anmeldung",
  nativeAuthenticationHelp:
    "Bei OpenCode gilt der API-Key für OpenAI. Andere Anbieter richtest du über „Anmelden“ ein. Bei einem gespeicherten Key lässt ein leeres Feld den bisherigen Wert unverändert.",
  formNote: "Zugangsdaten werden nur lokal gespeichert.",
};
export const accountsPageCopy = {
  signedIn: "Angemeldet",
  defaultAccount: "Standardkonto",
  setDefaultAccount: "Als Standard verwenden",
  useDefaultAccount: (name) => `${name} als Standard verwenden`,
  pageToplineLabel: "WORKSPACE / KONTEN",
  subtle: " Lokal gespeichert",
  pageHeadingTitle: "Deine Konten",
  pageHeadingDescription: "Ein Workspace. Für alle deine Identitäten.",
  localProfileDescription: "Vorhandenes CLI-Profil auf dem AgentPier-Server",
  managedProfileWithKey: "Eigenes Profil · API-Key gespeichert",
  managedProfileDescription: "Eigenes Profil",
  iconButtonAriaLabel: (value1) => `${value1} löschen`,
  accountInfoHeading: "Alles bleibt auf deinem Rechner.",
  accountInfoDescription:
    "Eigene Profile haben getrennte Anmeldungen und Konfigurationen. Lokale Profile verwenden die vorhandene CLI-Anmeldung auf dem AgentPier-Server. Wähle ein eigenes Profil als Standardkonto, wenn dort noch keine Anmeldung besteht.",
};
