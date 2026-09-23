/** Existing German product copy, addressed through English semantic keys. */
export const ssh = Object.freeze({
  invalidBinding: "Ungültige SSH-Zuordnung.",
  invalidStoredBinding: "Ungültige gespeicherte SSH-Zuordnung.",
  accessNotBound: "Dieser SSH-Zugang ist der Sitzung nicht zugeordnet.",
  loginSessionsUnsupported: "SSH-Zugänge sind für Login-Sitzungen nicht verfügbar.",
  invalidProjectReassignment: "Ungültige Neuzuordnung des SSH-Projekts.",
  projectCollision:
    "Das Zielprojekt enthält bereits einen passenden Schlüssel oder Host.",
  downloadRateLimited:
    "Zu viele Downloads privater Schlüssel. Bitte in einer Minute erneut versuchen.",
  downloadFailed: "Der Download des SSH-Schlüssels ist fehlgeschlagen.",
  managementRequired: "Der SSH-Katalog benötigt seinen Verwaltungsdienst.",
  keyNotFound: "SSH-Schlüssel nicht gefunden.",
  keySaveFailed: "Der SSH-Schlüssel konnte nicht gespeichert werden.",
  invalidKeyPreparation: "Ungültige Vorbereitung des SSH-Schlüssels.",
  keyInUse: "Der SSH-Schlüssel wird noch von einem Host verwendet.",
  invalidIdentity: "Ungültige SSH-Identität.",
  invalidAccessFields: "Ungültige Angaben für den SSH-Zugang.",
  invalidEndpoint: "Ungültiger SSH-Host oder -Port.",
  invalidUsername: "Ungültiger SSH-Benutzername.",
  invalidPublicKey: "Ungültiger öffentlicher SSH-Schlüssel.",
  keyPreparationFailed:
    "Der SSH-Schlüssel konnte nicht vorbereitet werden. Bitte einen unverschlüsselten privaten Schlüssel importieren oder einen neuen Schlüssel erzeugen.",
  migrationFailed:
    "Vorhandene SSH-Schlüssel konnten nicht übernommen werden. Bitte die lokalen SSH-Datendateien prüfen.",
  accessNotFound: "SSH-Zugang nicht gefunden.",
  chooseOneKey:
    "Bitte entweder einen gespeicherten SSH-Schlüssel oder einen privaten Schlüssel wählen.",
  keyInOtherProject: "Der SSH-Schlüssel gehört zu einem anderen Projekt.",
  accessSaveFailed: "Der SSH-Zugang konnte nicht gespeichert werden.",
  confirmChangedHostKey:
    "Bitte den SSH-Hostschlüssel für den geänderten Endpunkt bestätigen.",
  hostKeyScanFailed: "Die Abfrage des SSH-Hostschlüssels ist fehlgeschlagen.",
  connectionFailed:
    "Die SSH-Verbindung ist fehlgeschlagen. Bitte Endpunkt, installierten öffentlichen Schlüssel und bestätigten Hostschlüssel prüfen.",
  catalogUnavailable: "Der SSH-Katalog ist nicht verfügbar.",
  catalogCapacity: "Die Kapazität des SSH-Katalogs ist erreicht.",
  managementBusy:
    "Die SSH-Verwaltung ist ausgelastet. Bitte mit derselben Anfrage-ID erneut versuchen.",
  requestInterrupted: "Die SSH-Anfrage wurde unterbrochen.",
  projectUnavailable: "Das SSH-Projekt ist nicht verfügbar.",
  projectChanged: "Die Identität des SSH-Projekts hat sich geändert.",
  projectChangedReload: "Das SSH-Projekt hat sich geändert. Bitte die Sitzung neu laden.",
  projectDirectoryUnavailable: "Das SSH-Projektverzeichnis ist nicht verfügbar.",
  targetProjectRequired: "Ein Zielprojekt ist erforderlich.",
  sourceProjectUnavailable: "Das SSH-Quellprojekt ist nicht verfügbar.",
  unsupportedAccount: "Dieses Konto unterstützt keine SSH-Werkzeuge.",
  reservedMcpName: "Der reservierte SSH-MCP-Name ist bereits konfiguriert.",
  discoveryFailed: "Die SSH-Erkennungs-Hooks konnten nicht eingerichtet werden.",
  interactiveSessionsOnly:
    "SSH-Zugänge können nur laufenden interaktiven Sitzungen zugeordnet werden.",
});
