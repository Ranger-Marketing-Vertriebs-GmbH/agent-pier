/** Existing German product copy, addressed through English semantic keys. */
export const sessions = Object.freeze({
  invalidAgentBusSelection: "Ungültige AgentBus-Auswahl.",
  invalidAgentAccess: "Ungültige Agenten-Freigabe.",
  agentAccessCodingOnly:
    "Nur laufende Coding-Sessions (Claude Code, Codex, OpenCode) können mit einem Agenten sprechen.",
  talkAgentNotFound:
    "Diesen Agenten gibt es nicht, oder diese Session darf nicht mit ihm sprechen.",
  talkInvalid:
    "Die Nachricht an den Agenten ist leer, länger als 8000 Zeichen oder enthält Steuerzeichen.",
  talkLimit: (seconds) =>
    `Zu viele Nachrichten zwischen dieser Session und dem Agenten. Versuche es in ${seconds} Sekunden erneut.`,
  talkUnavailable: "Der Agent ist gerade nicht erreichbar.",
  invalidSandboxProfile: "Ungültiges Sandbox-Profil.",
  sandboxUnavailable:
    "nono ist auf diesem Rechner nicht installiert. Die Session wurde nicht gestartet.",
  sandboxProfileUnknown:
    "Dieses Sandbox-Profil ist nicht verfügbar. Bitte wählen Sie ein anderes.",
  sandboxNotForLogin: "Login-Sessions können nicht in der Sandbox laufen.",
  sandboxLoginPending:
    "Die Session wurde nicht gestartet: Die Anmeldung dieses Accounts liegt noch im macOS-Schlüsselbund, den eine Sandbox nicht lesen kann. Beende die Sessions des Accounts; AgentPier verschiebt die Anmeldung dann in den Ordner des Accounts. Starte die Sandbox-Session danach erneut.",
  sandboxNotForPipeline:
    "Pipeline-Stufen können in dieser Version nicht in der Sandbox laufen.",
  sandboxNotForTaskProfile:
    "Das Sandbox-Profil ist bei Starts mit Aufgabenprofil nicht verfügbar.",
  sandboxProfilesRateLimited:
    "Zu viele Abfragen der Sandbox-Profile. Bitte in einer Minute erneut versuchen.",
  loginNameSuffix: " · Anmeldung",
  sessionLimitReached:
    "Maximal 30 Sessions gleichzeitig. Bitte zuerst eine Session beenden.",
  stopBeforeLogin:
    "Bitte die laufenden Sessions dieses Accounts vor einer neuen Anmeldung beenden.",
  invalidAdapterConfiguration: "Die Adapter-Konfiguration der Session ist ungültig.",
  invalidNativeBinding: "Ungültige native Session-Zuordnung.",
  invalidNativeBindingKey: "Ungültiger Schlüssel für die native Session-Zuordnung.",
  nativeProjectMismatch: "Die native Session gehört zu einem anderen Projekt.",
  nativeProcessAlreadyBound:
    "Ein anderer laufender Prozess hat diese Session bereits zugeordnet.",
  codexHooksCannotBeMerged:
    "Die temporären Codex-Hooks können nicht sicher ergänzt werden.",
  unknownCodexHookFormat: "Die temporären Codex-Hooks haben ein unbekanntes Format.",
  temporaryTuiConfigConflict:
    "Eine zusätzliche temporäre OpenCode-TUI-Konfiguration ist bereits gesetzt.",
  activityWorking: "Arbeitet",
  activityReady: "Bereit",
  activityWaiting: "Wartet auf Eingabe",
  activityUnknown: "Aktivität unbekannt",
  activityStopped: "Beendet",
  shellConfigurationRestricted:
    "Shell-Sessions verwenden nur das lokale Terminal ohne AgentBus oder CLI-Startmodus.",
  shellModelPickerUnavailable: "Modellauswahl ist in Shell-Sessions nicht verfügbar.",
  loginModelPickerUnavailable: "Modellauswahl ist während der Anmeldung nicht verfügbar.",
  stopped: "Die Session ist beendet.",
  nativeProcessStopped: "Der native Session-Prozess wurde beendet.",
  nativeSessionIdMissing: "Die native Session-ID fehlt.",
  nativeBindingAlreadyExists: "Diese native Session-Zuordnung existiert bereits.",
  invalidName: "Ungültiger Session-Name.",
  notFound: "Session nicht gefunden.",
  invalidOptions: "Ungültige Session-Optionen.",
  invalidTool: "Ungültiges Tool für die Session.",
  invalidWorkingDirectory: "Ungültiges Arbeitsverzeichnis.",
  invalidExecutable: "Ungültige ausführbare Datei.",
  invalidArguments: "Ungültige Befehlsargumente.",
  invalidEnvironment: "Ungültige Umgebungsvariablen.",
  alreadyExists: "Die Session existiert bereits.",
  invalidControlKeys: "Ungültige Steuertasten.",
  invalidSubmitFlag: "Ungültige Angabe zum Absenden.",
  reloading: "Die Session wird neu geladen.",
  stopBeforeDelete: "Bitte die laufende Session vor dem Löschen beenden.",
  toolsStandaloneOnly:
    "AgentPier-Tools sind nur in eigenständigen Coding-Sessions verfügbar.",
  nativeModelNativeOnly:
    "Ein natives Modell kann nur für eine native Coding-Session gewählt werden.",
  invalidNativeModel:
    "Das native Modell muss eine exakte Modellkennung mit höchstens 200 Zeichen sein.",
});
