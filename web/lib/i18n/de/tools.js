export const toolInstallerCopy = {
  updateCli: "CLI aktualisieren",
  updateTitle: (name) => `${name} aktualisieren`,
  updateDescription:
    "Aktualisiert die CLI auf dem AgentPier-Server. Laufende Sitzungen arbeiten weiter; neue oder neu geladene Sitzungen verwenden die aktualisierte Version.",
  migrationDescription:
    "Diese CLI wurde über npm von AgentPier installiert. Sie wird zuerst mit dem offiziellen Installationsskript auf eine native Installation umgestellt. Die bisherigen Programmdateien bleiben für laufende Sitzungen erhalten; Konten und Unterhaltungen bleiben bestehen.",
  backgroundUpdateDescription:
    "Du kannst dieses Fenster schließen. Das Update läuft im Hintergrund weiter.",
  migrateNow: "Umstellen & aktualisieren",
  updateNow: "Jetzt aktualisieren",
  updating: "CLI wird aktualisiert …",
  updated: "CLI aktualisiert",
  updateReady: "CLI-Update",
  nativeInstaller: "Offizieller nativer Installer",
  nativeInstallationDescription:
    "Verwendet das offizielle Installationsskript im Benutzerverzeichnis des AgentPier-Servers. Die CLI behält ihren nativen Update-Mechanismus; Claude und OpenCode können automatisch aktualisieren. Konto-Anmeldungen bleiben in ihren getrennten Profilen. Bestehende Installationen werden nicht ersetzt.",
  serverInstallationDescription:
    "Installiert wird auf dem Rechner, auf dem AgentPier läuft (Server).",
  installationPreparing: "Installation wird vorbereitet …",
  toolInstallDetailsText: "Zielverzeichnis auf dem Server",
  isolatedInstallationDescription:
    "AgentPier installiert die CLI in seinem eigenen Verzeichnis. Bestehende Installationen bleiben erhalten.",
  backgroundInstallationDescription:
    "Du kannst dieses Fenster schließen. Die Installation läuft im Hintergrund weiter.",
  toolInstallReason:
    "Eine andere CLI wird gerade installiert. Bitte warte, bis sie fertig ist.",
  refreshInstallationStatus: "Status aktualisieren",
  refreshingInstallationStatus: "Status wird aktualisiert …",
  githubCredentials: "GitHub-Zugänge",
  startingInstallation: "Installation startet …",
  retryInstallation: "Erneut installieren",
};
export const useToolInstallationCopy = {
  installationUnavailable: "Für dieses Tool ist keine Installation verfügbar.",
  cliNotDetected: "Die CLI wird noch nicht erkannt. Bitte den Status aktualisieren.",
};
