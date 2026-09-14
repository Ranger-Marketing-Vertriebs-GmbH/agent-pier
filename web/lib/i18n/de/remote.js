export const remoteCopy = {
  title: "Fernzugriff",
  description: "Wie AgentPier von anderen Geräten erreichbar ist.",
  local: "Lokal",
  localDescription: "Immer aktiv. Nur auf diesem Rechner erreichbar.",
  tailscale: "Tailscale",
  tailscaleDescription:
    "Privates HTTPS im eigenen Tailnet, gebunden an das freigegebene Tailscale-Konto.",
  tailscaleOff: "Nicht eingerichtet. Auf dem Server: npm run tailscale",
  network: "Netzwerk",
  networkSwitch: "Netzwerkzugriff",
  networkDescription:
    "Ohne TLS unter der Adresse dieses Rechners erreichbar. Nur die Anmeldung schützt den Arbeitsbereich.",
  warningTitle: "Klartext-HTTP einschalten?",
  warning:
    "WARNUNG: Netzwerkzugriff ohne TLS. Passwort und Inhalte gehen unverschlüsselt durchs Netz. Keine Push-Benachrichtigungen und keine PWA-Installation. Nur in vertrauenswürdigen Netzen verwenden und keine Portweiterleitung ins Internet einrichten.",
  warningConfirm: "Trotzdem einschalten",
  warningCancel: "Abbrechen",
  activeWarning: "Netzwerkzugriff ohne TLS ist aktiv. Nur für vertrauenswürdige Netze.",
  bind: "Bind-Adresse",
  bindAll: "Alle Schnittstellen (0.0.0.0)",
  bindAllV6: "Alle Schnittstellen inkl. IPv6 (::)",
  hosts: "Zusätzliche Hosts",
  hostsDescription:
    "Namen oder IPs ohne Port, etwa ein eigener DNS-Name oder der Host eines Reverse-Proxys. Erkannte Adressen sind automatisch erlaubt.",
  hostInput: "Zusätzlicher Host",
  addHost: "Host hinzufügen",
  removeHost: (host) => `${host} entfernen`,
  urls: "Erreichbare Adressen",
  locked:
    "Über den Netzwerkzugriff kann der Modus nur ausgeschaltet werden. Bind-Adresse und Hostliste lokal oder über Tailscale ändern.",
  save: "Speichern",
  saved: "Gespeichert.",
  restartRequired: "Neustart erforderlich, damit die Änderung gilt.",
  restart: "Dienst neu starten",
  restarting: "Dienst startet neu …",
  restarted: "Dienst neu gestartet.",
  restartFailed:
    "Der Dienst hat sich nicht neu gemeldet. Manuell neu starten: npm run service:install oder npm start.",
  scriptHint: "Headless: npm run remote -- enable --accept-plain-http",
  loading: "Fernzugriff wird geladen …",
};
