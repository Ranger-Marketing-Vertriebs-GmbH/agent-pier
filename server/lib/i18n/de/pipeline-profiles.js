/** German browser-visible pipeline profile messages, addressed through English semantic keys. */
export const pipelineProfiles = Object.freeze({
  invalidProfileDescription: "Ungültige Profilbeschreibung",
  invalidModel: "Ungültiges Modell",
  invalidRolePrompt: "Ungültiger Rollen-Prompt",
  invalidKickoffPrompt: "Ungültiger Start-Prompt",
  invalidParameterLabel: "Ungültige Parameterbezeichnung",
  invalidParameterValue: "Ungültiger Parameterwert",
  invalidRenderedPrompt: "Ungültiger zusammengesetzter Profil-Prompt",
  invalidVerificationStepName: "Ungültiger Name des Prüfschritts",
  invalidVerificationCommand: "Ungültiger Prüfbefehl",
  invalidPipelineDescription: "Ungültige Pipeline-Beschreibung",
  connectionsUnavailable: "Provider-Verbindungen sind nicht verfügbar.",
  connectionUnsupported:
    "Diese Verbindung unterstützt das CLI des Profils nicht oder erfordert Zugriff auf die Responses API.",
  enabledBoolean: "enabled im Profil muss ein Boolean sein",
  invalidCli: "Ungültiges Profil-CLI",
  accountCliMismatch: "Account und CLI des Profils müssen übereinstimmen",
  modelCount: "Ein Profil benötigt 1–100 verfügbare Modelle",
  defaultModelUnavailable: "Das Standardmodell muss im Profil verfügbar sein",
  invalidPermissionMode: (tool) => `Ungültiger ${tool}-Berechtigungsmodus`,
  autonomousBoolean: "autonomous im Profil muss ein Boolean sein",
  parameterLimit: "Ein Profil darf höchstens 30 Parameter haben",
  invalidParameter: "Ungültiger oder doppelter Profilparameter",
  parameterRequiredBoolean: "required beim Parameter muss ein Boolean sein",
  invalidParameters: "Ungültige Profilparameter",
  unknownParameter: (key) => `Unbekannter Profilparameter: ${key}`,
  parameterRequired: (label) => `Profilparameter ist erforderlich: ${label}`,
  modelUnavailable: "Das Modell ist in diesem Profil nicht verfügbar",
  verificationStepLimit: "Die Prüfung darf höchstens 20 Schritte haben",
  verificationTimeoutRange:
    "Das Zeitlimit der Prüfung muss 1000–7200000 Millisekunden betragen",
  verificationBlockingBoolean: "blocking bei der Prüfung muss ein Boolean sein",
  verificationTotalTimeout:
    "Das gesamte Zeitlimit der Prüfung darf zwei Stunden nicht überschreiten",
  invalidNativePermissionMode: (tool) => `Ungültiger ${tool}-Berechtigungsmodus.`,
  accountConfigurationChanged:
    "Die Account-Konfiguration des Profils wurde geändert. Bitte einen neuen Lauf mit dem aktualisierten Profil starten.",
  providerConfigurationChanged:
    "Die Provider-Konfiguration des Profils wurde geändert. Bitte einen neuen Lauf mit dem aktualisierten Profil starten.",
  claudePermissionModeUnverified:
    "Der native Claude-Berechtigungsmodus konnte nicht geprüft werden.",
  claudePermissionModeUnsupported:
    "Diese Claude-Version bietet den Berechtigungsmodus des Profils nicht an.",
  disabled: "Dieses Profil ist deaktiviert.",
  invalidSessionCli: "Ungültiges Sitzungs-CLI.",
  mustBeEnabledAndAutonomous: (name) =>
    `Das Pipeline-Profil muss aktiviert und autonom sein: ${name}`,
  noRequiredParameters: (name) =>
    `Pipeline-Profile dürfen keine Pflichtparameter haben: ${name}`,
  stillReferenced: "Eine Pipeline verweist noch auf dieses Profil",
  accountCliChanged: "Das CLI des Profil-Accounts wurde geändert",
});
