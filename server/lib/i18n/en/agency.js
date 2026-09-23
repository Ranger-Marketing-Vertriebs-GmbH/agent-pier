/** English counterpart of de/agency.js with identical keys. */
export const agency = Object.freeze({
  stopping: "AgentPier is stopping.",
  invalidRevision: "Agency Agents returned an invalid revision.",
  licenseChanged:
    "The Agency Agents license changed; review the source before importing.",
  catalogChanged: "The Agency catalog changed. Refresh the preview before installing.",
  agentNotFound: "Agency agent not found.",
  alreadyInstalled: "This Agency agent is already installed.",
  notInstalledForCli: "Agency agent is not installed for this CLI.",
  outsideAgentDirectory: "The agent file is outside this CLI's agent directory.",
  changedOutside: "The agent file changed outside AgentPier; it was retained.",
  downloadFailed: (status) => `Agency Agents download failed (HTTP ${status}).`,
  emptyResponse: "Agency Agents returned an empty response.",
  downloadLimit: "Agency Agents response exceeds the download limit.",
  incompleteCatalog: "Agency Agents returned an incomplete catalog.",
  yamlMissing: "Agency agent is missing YAML metadata.",
  invalidMetadata: "Agency agent metadata is invalid.",
  aliasesUnsupported: "Agency agent metadata aliases are unsupported.",
  invalidIdentity: "Agency agent identity or description is invalid.",
});
