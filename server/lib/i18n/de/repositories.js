/** Existing German product copy, addressed through English semantic keys. */
export const repositories = Object.freeze({
  githubAuthenticationFailed:
    "GitHub-Anmeldung fehlgeschlagen. Bitte das Token aktualisieren.",
  githubAccessDenied:
    "GitHub verweigert den Zugriff. Bitte Token-Berechtigungen, Organisationsfreigabe oder API-Limit prüfen.",
  githubRateLimited: "GitHub-API-Limit erreicht. Bitte später erneut versuchen.",
  githubListFailed: "Repositories konnten bei GitHub nicht geladen werden.",
  githubResponseTooLarge: "Die GitHub-Antwort ist zu groß.",
  invalidGithubRepositoryList: "GitHub hat eine ungültige Repository-Liste geliefert.",
  searchCancelled:
    "Repository-Suche abgebrochen oder Zeitlimit erreicht. Bitte erneut versuchen.",
  githubConnectionFailed:
    "GitHub konnte nicht sicher erreicht werden. Bitte Host, Netzwerk und HTTPS-Verbindung prüfen.",
  validHttpsHostRequired: "Bitte einen gültigen HTTPS-Host ohne Pfad eingeben.",
  httpsHostRequired: "Bitte einen HTTPS-Host ohne Pfad eingeben.",
  invalidHttpsHost: "Ungültiger HTTPS-Host.",
  invalidAccessToken: "Ungültiges Zugriffstoken.",
  accessTokenRequired: "Bitte ein Zugriffstoken eingeben.",
  repositoryAddressRequired: "Bitte eine HTTPS-Repository-URL oder owner/repo eingeben.",
  invalidRepositoryUrl: "Ungültige Repository-URL.",
  repositoryHostMismatch:
    "Die Repository-URL muss zum HTTPS-Host des gewählten Profils gehören und darf keine Zugangsdaten enthalten.",
  gitUnavailable: "Git konnte nicht gestartet werden. Bitte die Git-Installation prüfen.",
  cloneTimeout: "Zeitlimit beim Klonen erreicht. Bitte Netzwerk und Repository prüfen.",
  cloneFailed:
    "Klonen fehlgeschlagen. Bitte Repository-URL, Token-Berechtigungen und Netzwerk prüfen.",
  cloneAuthenticationFailed:
    "Anmeldung fehlgeschlagen. Bitte Token und Repository-Berechtigungen prüfen.",
  cloneCertificateFailed:
    "Die HTTPS-Verbindung konnte nicht verifiziert werden. Bitte Zertifikate und Netzwerk prüfen.",
  cloneRedirectUnsupported:
    "Der Server leitet die Anfrage weiter. Bitte die endgültige HTTPS-Repository-URL verwenden.",
  profileNotFound: "GitHub-Profil nicht gefunden.",
  invalidDefaultAgent: "Ungültige Agent-Standardauswahl.",
  invalidSearchText: "Bitte einen Suchtext mit maximal 200 Zeichen eingeben.",
  invalidOrganization: "Ungültige Organisation.",
  invalidPage: "Ungültige Ergebnisseite.",
  profileTokenMissing:
    "Das Zugriffstoken dieses Profils fehlt. Bitte das Profil aktualisieren.",
  cloneServiceStopping:
    "Der Server wird beendet. Neue Klonvorgänge sind nicht mehr möglich.",
  newFolderNameRequired: "Bitte einen neuen Ordnernamen ohne Pfad eingeben.",
  targetFolderRequired: "Bitte einen vorhandenen Zielordner angeben.",
  targetParentUnavailable:
    "Der übergeordnete Zielordner existiert nicht oder ist nicht zugänglich.",
  targetAlreadyExists:
    "Der Zielordner existiert bereits. Bitte einen neuen Namen wählen.",
  targetCreateFailed: "Der Zielordner konnte nicht erstellt werden.",
  clonedProjectSaveFailed: "Das geklonte Projekt konnte nicht gespeichert werden.",
  cloneTargetOrTokenFailed:
    "Klonen fehlgeschlagen. Bitte Zugriffstoken und Zielordner prüfen.",
  invalidTemporaryGitConfig: "Die temporäre Git-Konfiguration ist ungültig.",
  sessionConfigUnavailable: "Die GitHub-Sitzungskonfiguration ist nicht zugänglich.",
  sessionConfigUpdateFailed:
    "Eine GitHub-Sitzungskonfiguration konnte nicht aktualisiert werden.",
  sessionConfigRemoveFailed:
    "Die GitHub-Sitzungskonfiguration konnte nicht entfernt werden.",
  cloneShutdown: "Klonen wegen Server-Shutdown abgebrochen.",
  sessionConfigAlreadyExists: "Diese GitHub-Sitzungskonfiguration existiert bereits.",
});
