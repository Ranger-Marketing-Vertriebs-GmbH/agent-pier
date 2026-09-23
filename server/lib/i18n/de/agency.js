/** German browser-visible Agency Agents messages, addressed through English semantic keys. */
export const agency = Object.freeze({
  stopping: "AgentPier wird beendet.",
  invalidRevision: "Agency Agents hat eine ungültige Revision geliefert.",
  licenseChanged:
    "Die Lizenz von Agency Agents hat sich geändert; bitte vor dem Import die Quelle prüfen.",
  catalogChanged:
    "Der Agency-Katalog hat sich geändert. Bitte vor der Installation die Vorschau aktualisieren.",
  agentNotFound: "Agency-Agent nicht gefunden.",
  alreadyInstalled: "Dieser Agency-Agent ist bereits installiert.",
  notInstalledForCli: "Der Agency-Agent ist für dieses CLI nicht installiert.",
  outsideAgentDirectory:
    "Die Agent-Datei liegt außerhalb des Agent-Verzeichnisses dieses CLI.",
  changedOutside:
    "Die Agent-Datei wurde außerhalb von AgentPier geändert; sie wurde beibehalten.",
  downloadFailed: (status) =>
    `Download von Agency Agents fehlgeschlagen (HTTP ${status}).`,
  emptyResponse: "Agency Agents hat eine leere Antwort geliefert.",
  downloadLimit: "Die Antwort von Agency Agents überschreitet das Download-Limit.",
  incompleteCatalog: "Agency Agents hat einen unvollständigen Katalog geliefert.",
  yamlMissing: "Dem Agency-Agent fehlen YAML-Metadaten.",
  invalidMetadata: "Die Metadaten des Agency-Agents sind ungültig.",
  aliasesUnsupported:
    "Aliase in den Metadaten des Agency-Agents werden nicht unterstützt.",
  invalidIdentity: "Identität oder Beschreibung des Agency-Agents ist ungültig.",
});
