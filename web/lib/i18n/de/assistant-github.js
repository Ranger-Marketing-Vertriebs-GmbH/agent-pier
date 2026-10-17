export const assistantGithubCopy = {
  row: "GitHub",
  title: "GitHub",
  intro:
    "Der Agent arbeitet mit einem deiner Tokenprofile auf GitHub: über den offiziellen GitHub-MCP-Server und, mit Shell-Zugriff, mit gh und git. Der Token steht nie in seinen Anweisungen oder Dateien; mit Shell-Zugriff kann er ihn wie du lesen.",
  none: "Kein Zugriff",
  profileLegend: "Tokenprofil",
  levelLegend: "Zugriff",
  levels: { read: "Lesen", write: "Lesen und schreiben" },
  levelHints: {
    read: "Repositories, Issues, Pull Requests und Actions-Läufe, nur lesend.",
    write:
      "Kommentiert und erstellt außerdem Issues und Pull Requests, führt Pull Requests zusammen, pusht, ändert und löscht Dateien. Repositories anlegen, forken und löschen sowie Workflows starten bleibt aus.",
  },
  summary: (level, profile) => `${level} · ${profile}`,
  agentDefault: "Standard für Agenten",
  noProfiles: "Es gibt noch kein GitHub-Tokenprofil.",
  manage: "Tokenprofile einrichten",
  profileMissing: "Das gewählte Tokenprofil gibt es nicht mehr. Wähle ein anderes.",
  missingScopes: (scopes) => `Diesem Token fehlt der nötige Scope: ${scopes}.`,
  shellNote:
    "Mit Shell-Zugriff nutzen gh und git in den Befehlen dieses Agenten dieses Profil statt deiner eigenen Anmeldung.",
  writeWarning:
    "Der Agent kann in deinem Namen kommentieren, Pull Requests öffnen und zusammenführen, Änderungen pushen und Dateien löschen, ohne Freigabe pro Änderung. Inhalte, die er auf GitHub liest, können ihn steuern.",
  memoryNote:
    "Jedes Profil mit jeder Stufe läuft als eigener GitHub-MCP-Server, der für jede Agentensitzung startet (je etwa 45 MB Arbeitsspeicher).",
  server: {
    installing: "Der GitHub-MCP-Server wird installiert …",
    failed: "Der GitHub-MCP-Server konnte nicht installiert werden.",
    retry: "Erneut versuchen",
    unavailable:
      "Für dieses System gibt es keinen verwalteten GitHub-MCP-Server; gh und git funktionieren mit Shell-Zugriff trotzdem.",
    missing: "Der GitHub-MCP-Server wird beim Speichern installiert.",
    ready: (version) => `GitHub-MCP-Server ${version}`,
  },
};
