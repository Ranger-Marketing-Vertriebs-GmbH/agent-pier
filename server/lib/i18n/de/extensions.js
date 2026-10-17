/** Existing German product copy, addressed through English semantic keys. */
export const extensions = Object.freeze({
  shellManagementUnavailable:
    "Für Shell-Sitzungen gibt es keine MCP- oder Skill-Verwaltung.",
  sharedUserSkillScope: "Benutzer · von Codex und kompatiblen CLIs geteilt",
  codexProfileSkillScope: "Codex-Profil · vorhandene Skills",
  systemReadOnlyScope: "System · schreibgeschützt",
  claudeProfileScope: "Claude-Profil",
  claudeUserScope: "Claude-Benutzer",
  openCodeProfileScope: "OpenCode-Profil",
  openCodeUserScope: "OpenCode-Benutzer",
  invalidMcpObject:
    "Die MCP-Konfiguration ist kein gültiges Objekt. Sie wurde nicht verändert.",
  incompleteSkillMetadata:
    "Metadaten unvollständig oder nicht portabel. Bitte SKILL.md prüfen.",
  mcpScopeNotice:
    "Profilweite MCP-Konfiguration. Projekte und Plugins können weitere Server hinzufügen. Änderungen gelten beim nächsten CLI-Start; hier wird kein Server gestartet.",
  skillVisibilityNotice: (scope) =>
    `${scope}. Angezeigt werden bekannte Benutzer- und Profilordner; projekt- und pluginabhängige Skills sind nicht vollständig erfasst. Entfernen ist nur für hier installierte Skills möglich.`,
  skillSourceRequired: "Bitte Datei oder URL wählen.",
  invalidSkillUpload: "Bitte eine gültige Datei mit maximal 10 MiB hochladen.",
  skillFileTypeRequired: "Bitte SKILL.md oder eine ZIP-Datei hochladen.",
  skillDirectoryAlreadyExists:
    "Dieser Skill-Ordner existiert bereits. Vorhandene Dateien wurden nicht verändert.",
  skillSaveFailed:
    "Der Skill konnte nicht gespeichert werden. Vorhandene Skills wurden nicht verändert.",
  skillNotInstalledHere: "Dieser Skill wurde hier nicht installiert.",
  skillDirectoryReplaced:
    "Der Skill-Ordner wurde außerhalb von AgentPier ersetzt und bleibt unverändert.",
  invalidEnvironmentOrHeadersObject:
    "Umgebungsvariablen und Header müssen JSON-Objekte mit maximal 100 Einträgen sein.",
  invalidEnvironmentOrHeader: "Ungültige Umgebungsvariable oder ungültiger Header.",
  invalidArgumentList: "Argumente müssen eine JSON-Liste von Zeichenketten sein.",
  invalidMcpUrl: "Bitte eine gültige HTTP- oder HTTPS-MCP-URL eingeben.",
  targetOutsideProfile: "Der Zielpfad liegt außerhalb des Profils.",
  linkedPathsReadOnly:
    "Verknüpfte Konfigurations- oder Skill-Pfade sind hier schreibgeschützt.",
  cliConfigTooLarge:
    "Die CLI-Konfiguration ist größer als 64 MiB; AgentPier liest und ändert sie nicht.",
  invalidCliConfigFile: "Die CLI-Konfiguration ist kein reguläres Dokument.",
  invalidExistingCliConfig:
    "Die vorhandene CLI-Konfiguration ist ungültig. Sie wurde nicht verändert.",
  cliConfigChanged: "Die CLI-Konfiguration wurde gleichzeitig geändert. Bitte neu laden.",
  cliConfigLayout:
    "Dieser Eintrag lässt sich in der vorhandenen CLI-Konfiguration nicht gezielt ändern. Sie wurde nicht geändert.",
  skillDocumentTooLarge: "SKILL.md darf höchstens 256 KiB groß sein.",
  skillFrontmatterRequired:
    "SKILL.md benötigt YAML-Frontmatter mit name und description.",
  invalidSkillFrontmatter: "Das Skill-Frontmatter ist ungültig.",
  unsafeZipPath: "Das ZIP enthält einen unsicheren Dateipfad.",
  skillZipTooLarge: "Das ZIP darf höchstens 10 MiB groß sein.",
  skillZipUnreadable: "Das ZIP konnte nicht gelesen werden.",
  skillZipCorrupt: "Das ZIP ist ungültig oder beschädigt.",
  skillFileCountExceeded: "Ein Skill-Paket darf höchstens 1.000 Dateien enthalten.",
  specialSkillFilesForbidden:
    "Links und spezielle Dateien sind in Skill-Paketen nicht erlaubt.",
  encryptedSkillZipUnsupported: "Verschlüsselte ZIP-Dateien werden nicht unterstützt.",
  extractedSkillTooLarge: "Das entpackte Skill-Paket darf höchstens 20 MiB groß sein.",
  duplicateSkillZipPaths: "Das ZIP enthält doppelte Dateipfade.",
  skillZipSizeMismatch: "Das ZIP überschreitet seine Größenangaben.",
  singleSkillRequired:
    "Bitte genau einen Skill mit SKILL.md hochladen oder den GitHub-Link zu dessen Ordner angeben.",
  skillConfigurationForbidden:
    "Bitte einen Skill ohne Plugin- oder MCP-Konfiguration hochladen.",
  publicSkillSourceRequired:
    "Bitte einen öffentlichen GitHub-Ordner oder ZIP-Link eingeben.",
  skillDownloadHostRestricted:
    "Downloads sind nur über öffentliche HTTPS-Links von github.com oder codeload.github.com möglich.",
  invalidGithubLink: "Ungültiger GitHub-Link.",
  githubSkillLinkRequired:
    "Bitte einen GitHub-Repository-, Ordner- oder ZIP-Link verwenden.",
  githubZipLinkRequired: "Bitte einen gültigen GitHub-ZIP-Link verwenden.",
  invalidGithubRedirect: "GitHub hat ein ungültiges Weiterleitungsziel geliefert.",
  skillDownloadFailed:
    "Das öffentliche Skill-Paket konnte nicht von GitHub geladen werden.",
  mcpUrlCredentialsForbidden:
    "Die MCP-URL muss HTTP oder HTTPS verwenden und darf keine eingebetteten Zugangsdaten enthalten.",
  invalidSkillIdentity:
    "Skill-Name: maximal 64 Kleinbuchstaben, Ziffern und Bindestriche. Eine Beschreibung mit maximal 1.024 Zeichen ist erforderlich.",
  skillDownloadTimedOut: "GitHub-Download fehlgeschlagen oder Zeitlimit erreicht.",
  skillDownloadRedirectLimit: "GitHub hat zu viele Weiterleitungen geliefert.",
  skillRefAmbiguous:
    "Dieser Name ist im Repository sowohl ein Branch als auch ein Tag. Bitte verwende den Commit-SHA.",
  skillRefNotFound:
    "Im Repository gibt es keinen Branch, Tag oder Commit mit diesem Namen.",
  skillRefRateLimited:
    "GitHub begrenzt gerade die Abfragen von diesem Rechner. Bitte später erneut versuchen oder den Commit-SHA verwenden.",
  skillRefLookupFailed: "GitHub konnte den Commit dieses Links nicht bestimmen.",
  packageSkillUnreadable:
    "Die Dateien dieses Skills ließen sich nicht lesen oder haben sich geändert. Bitte die Liste neu laden.",
  packageSkillNotFound: "Dieses Paket enthält keinen Skill mit diesem Namen.",
  packageSkillsUnavailable:
    "Die Skills des Pakets sind erst verfügbar, wenn das Paket installiert ist.",
});
