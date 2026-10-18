export const toolInstallerCopy = {
  externalUpdateNotice: (name, found, required) =>
    `${name} ${found} ist älter als die Mindestversion ${required}. AgentPier hat diese Installation nicht eingerichtet und kann sie nicht aktualisieren: Aktualisiere sie mit dem Paketmanager, über den sie installiert wurde (zum Beispiel Homebrew oder npm). Sessions starten trotzdem.`,
  versionLabel: (version) => `Version ${version}`,
  versionUnknown: "Version unbekannt",
  updateRequiredBadge: "Update nötig",
  minimumVersion: (required) => `Mindestens ${required} erforderlich`,
  installedVersion: (version) => `Installiert: ${version}`,
  pinnedVersion: (version) => `Verfügbar: ${version}`,
  chromeForTesting: "Chrome for Testing von Google, Version fest in AgentPier hinterlegt",
  chromiumInstallationDescription:
    "AgentPier lädt den Browser selbst, prüft Größe und SHA-256 und legt ihn in seinem eigenen Ordner ab. Kein Homebrew, keine Administratorrechte.",
  updateRequiredNotice: (name, found, required) =>
    `${name} ${found} ist älter als die Mindestversion ${required}. Aktualisiere die CLI, um eine Session zu starten.`,
  versionUnknownNotice: (name) =>
    `AgentPier konnte die Version von ${name} nicht lesen. Die Session startet trotzdem; falls etwas nicht funktioniert, aktualisiere die CLI.`,
  updateCli: "CLI aktualisieren",
  updateBrowser: "Browser aktualisieren",
  browserUpdateDescription:
    "Lädt die in AgentPier hinterlegte neuere Version des Agenten-Browsers. Laufende Agenten-Browser behalten bis zu einem Neustart des Agentendienstes die bisherige Version.",
  browserUpdating: "Browser wird aktualisiert …",
  browserUpdated: "Browser aktualisiert",
  browserUpdateReady: "Browser-Update",
  updateTitle: (name) => `${name} aktualisieren`,
  updateDescription:
    "Aktualisiert die CLI auf dem AgentPier-Server. Laufende Sessions arbeiten weiter; neue oder neu geladene Sessions verwenden die aktualisierte Version.",
  migrationDescription:
    "Diese CLI wurde über npm von AgentPier installiert. Sie wird zuerst mit dem offiziellen Installationsskript auf eine native Installation umgestellt. Die bisherigen Programmdateien bleiben für laufende Sessions erhalten; Accounts und Unterhaltungen bleiben bestehen.",
  backgroundUpdateDescription:
    "Du kannst dieses Fenster schließen. Das Update läuft im Hintergrund weiter.",
  migrateNow: "Umstellen & aktualisieren",
  updateNow: "Jetzt aktualisieren",
  updating: "CLI wird aktualisiert …",
  updated: "CLI aktualisiert",
  updateReady: "CLI-Update",
  nativeInstaller: "Offizieller nativer Installer",
  nativeInstallationDescription:
    "Verwendet das offizielle Installationsskript im Benutzerverzeichnis des AgentPier-Servers. Die CLI behält ihren nativen Update-Mechanismus; Claude und OpenCode können automatisch aktualisieren. Account-Anmeldungen bleiben in ihren getrennten Profilen. Bestehende Installationen werden nicht ersetzt.",
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
  reinstallationReady: "CLI fehlt – bereit zur erneuten Installation",
  retryInstallation: "Erneut installieren",
};
export const useToolInstallationCopy = {
  installationUnavailable: "Für dieses Tool ist keine Installation verfügbar.",
  cliNotDetected: "Die CLI wird noch nicht erkannt. Bitte den Status aktualisieren.",
};
