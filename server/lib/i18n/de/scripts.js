/** Existing German product copy, addressed through English semantic keys. */
export const scripts = Object.freeze({
  invalidSystemdValue: "Ungültiger Wert für die systemd-Konfiguration.",
  invalidServicePath: "Ungültiger absoluter Dienstpfad.",
  serviceNameConflict:
    "Der Dienstname wird von einer anderen Installation verwendet. Bestehende Datei bleibt unverändert.",
  unsupportedServicePlatform:
    "Die Dienstinstallation unterstützt macOS und Linux mit systemd. Alternativ npm start ausführen.",
  userServiceUnavailable:
    "AgentPier-Dienst ist nicht geladen oder der systemd-Benutzerdienst ist nicht erreichbar.",
  buildRequired: "Bitte zuerst npm run build ausführen.",
  systemctlUnavailable:
    "systemctl --user ist nicht erreichbar. Linux mit systemd und eine aktive Benutzersitzung sind erforderlich; alternativ npm start verwenden.",
  serviceNotLoaded: "AgentPier-Dienst ist nicht geladen.",
  deploymentHeading: "Dein Terminal. Überall.",
  browserCheckName: (toolName) => `Browserprüfung ${toolName}`,
  httpsPortsOccupied:
    "Alle vorgesehenen HTTPS-Ports sind belegt. Vorhandene Freigaben bleiben unverändert.",
  tailscaleDisconnected: "Tailscale ist nicht verbunden.",
  tailscaleIdentityUnavailable: "Tailscale-Identität konnte nicht ermittelt werden.",
  remoteAccessConfigured: (remoteUrl) =>
    `Fernzugriff eingerichtet: ${remoteUrl}\nNur das eigene Tailscale-Konto erhält Zugriff. Dienst mit npm run service:install neu laden.`,
  serverListening: (port) => `AgentPier läuft auf http://127.0.0.1:${port}`,
  serviceFileMustBeRegular: "Die Dienstdatei darf kein Symlink oder Verzeichnis sein.",
  absoluteXdgConfigRequired: "XDG_CONFIG_HOME muss ein absoluter Pfad sein.",
  invalidServerPort: "AGENTPIER_PORT muss zwischen 1024 und 65535 liegen.",
  serviceUsage: "Verwendung: service.mjs install|status|stop",
  webServiceStopped: "Webdienst gestoppt. Terminal-Sessions laufen in tmux weiter.",
  tailscaleUrlMissing: "Tailscale URL fehlt.",
  userServiceConfigured: (port) =>
    `AgentPier-Benutzerdienst eingerichtet: http://127.0.0.1:${port}`,
  serviceConfigured: (port) => `AgentPier-Dienst eingerichtet: http://127.0.0.1:${port}`,
});
