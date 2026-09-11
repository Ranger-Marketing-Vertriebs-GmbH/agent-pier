/** Existing German product copy, addressed through English semantic keys. */
export const plugins = Object.freeze({
  invalidCatalogAccount:
    "Bitte ein gültiges Codex-Konto für den Standardkatalog auswählen.",
  defaultCatalogSource: "Nativer Codex-Standardkatalog des ausgewählten Kontos",
  nativeMarketplaceSource: "Vom nativen Codex-Katalog bereitgestellt",
  remoteCatalogEmpty:
    "Für dieses Konto sind keine Standard-Plugins verfügbar. Ein bei Codex angemeldetes Konto auswählen und erneut laden.",
  remoteCatalogUnavailable:
    "Der Standardkatalog des ausgewählten Kontos konnte nicht geladen werden. Lokale Plugins bleiben verfügbar.",
  serviceStopping: "Die Plugin-Verwaltung wird beendet.",
  commandTimeout: "Der native Plugin-Befehl hat das Zeitlimit überschritten.",
  catalogSelectionRequired: "Bitte ein Plugin aus dem Marketplace-Katalog auswählen.",
  invalidMarketplaceName: "Ungültiger Marketplace-Name.",
  npmPackageRequired: "Bitte einen npm-Paketnamen mit optionaler Version angeben.",
  publicRepositoryRequired:
    "Bitte ein öffentliches HTTPS-Repository oder owner/repo angeben.",
  marketplaceUrlRestricted:
    "Marketplace-URLs müssen öffentliches HTTPS ohne Zugangsdaten, Parameter oder eigenen Port verwenden.",
  pathOutsideProfile: "Der Plugin-Pfad liegt außerhalb des Profils.",
  linkedConfigReadOnly:
    "Verknüpfte Plugin-Konfigurationspfade sind hier schreibgeschützt.",
  invalidConfigFile: "Die Plugin-Konfiguration ist zu groß oder kein reguläres Dokument.",
  duplicateConfigKeys:
    "Doppelte Konfigurationsschlüssel müssen zuerst im CLI-Profil korrigiert werden.",
  invalidExistingConfig:
    "Die vorhandene Plugin-Konfiguration ist ungültig und wurde nicht verändert.",
  shellManagementUnavailable: "Für Shell-Sitzungen gibt es keine Plugin-Verwaltung.",
  restartRequiredNotice:
    "Änderungen gelten für neue CLI-Sitzungen. Bereits laufende Sitzungen bleiben unverändert.",
  unsupportedCliJson:
    "Das CLI liefert kein unterstütztes Plugin-JSON. Bitte die CLI-Version prüfen.",
  unsupportedEntryFormat: "Ein Plugin-Eintrag hat ein nicht unterstütztes Format.",
  externalSourceScope: "Externe Quelle · nur im nativen Profil verwaltbar",
  openCodeConfigurationNotice:
    "OpenCode verwendet npm-Pakete und lokale Plugins, keine verwalteten Marketplaces. Server- und TUI-Konfiguration werden berücksichtigt. Änderungen werden in neuen CLI-Sitzungen geladen.",
  openCodeInstallerUnavailable:
    "Diese OpenCode-Version unterstützt noch keinen nativen Plugin-Installationsbefehl.",
  unsupportedPluginList: "Dieses native Plugin-Listenformat wird noch nicht unterstützt.",
  unsupportedMarketplaceList:
    "Dieses native Marketplace-Listenformat wird noch nicht unterstützt.",
  codexActivationNotice:
    " Aktivieren und Aktualisieren einzelner Codex-Plugins ist in dieser CLI-Verwaltung nicht verfügbar; /plugins bietet die native Aktivierung.",
  unknownAction: "Unbekannte Plugin-Aktion.",
  operationAlreadyRunning: "Für dieses CLI-Profil läuft bereits eine Plugin-Aktion.",
  marketplacesUnsupported: "Dieses CLI unterstützt keine verwalteten Marketplaces.",
  marketplaceNotFound: "Marketplace nicht gefunden.",
  detectedMarketplaceReadOnly:
    "Dieser automatisch erkannte Marketplace ist hier schreibgeschützt.",
  installationUnsupported:
    "Diese CLI-Version unterstützt die Plugin-Installation hier nicht.",
  actionUnsupported: "Diese Plugin-Aktion wird vom nativen CLI nicht unterstützt.",
  catalogPluginNotFound: "Plugin nicht im Marketplace-Katalog gefunden.",
  notFound: "Plugin nicht gefunden.",
  readOnly: "Dieses Plugin ist hier schreibgeschützt.",
  configurationUpdated:
    "Plugin-Konfiguration aktualisiert. Neue CLI-Sitzungen übernehmen die Änderung.",
  missingOrReadOnly: "Plugin nicht gefunden oder schreibgeschützt.",
  multipleVersionsConfigured:
    "Mehrere Versionen dieses Plugins sind konfiguriert. Bitte zuerst die nativen Konfigurationen bereinigen.",
  configChanged: "Die Plugin-Konfiguration wurde parallel geändert. Bitte neu laden.",
  shutdownCancelled: "Die Plugin-Verwaltung wurde beim Beenden gestoppt.",
  commandOutputLimit: "Der native Plugin-Befehl hat zu viele Daten ausgegeben.",
  commandFailed: "Der native Plugin-Befehl ist fehlgeschlagen.",
  externalPlugin: "Externes Plugin",
  globalPackageScope: "npm-Paket · globale CLI-Konfiguration",
  automaticLocalPlugin: "Automatisch geladenes lokales Plugin",
  claudeMarketplaceRemovalNotice:
    " Beim Entfernen eines Marketplaces deinstalliert Claude dessen Plugins. Gespeicherte Plugin-Daten bleiben bei einzelner Deinstallation erhalten.",
  alreadyInstalled: "Dieses Plugin ist bereits installiert.",
});
