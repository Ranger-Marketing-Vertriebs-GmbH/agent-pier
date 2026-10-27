export const reaCopy = {
  title: "REA",
  manage: "Verwalten",
  updateBadge: "Update verfügbar",
  working: "Läuft …",
  intro:
    "REA gibt Claude Code Tools, um Binärdateien zu analysieren. AgentPier lädt die Teile, die du wählst, prüft Größe und SHA-256 und legt sie in einen eigenen Ordner, getrennt von deiner eigenen Konfiguration.",
  loading: "REA wird geladen …",
  loadFailed: "Der Zustand von REA ließ sich nicht laden.",
  componentsLabel: "Bestandteile",
  core: "REA Core",
  coreDescription: "MCP-Server und Skill von REA. Immer dabei.",
  ghidra: "Ghidra mit Decompiler + Temurin JDK",
  ghidraDescription:
    "Dekompiliert nativen Code und bringt eine eigene Java-Laufzeit mit.",
  frida: "Frida",
  fridaDescription: "Instrumentiert laufende Prozesse für die dynamische Analyse.",
  version: (version) => `Version ${version}`,
  installedVersion: (version) => `Installiert: ${version}`,
  availableVersion: (version) => `Verfügbar: ${version}`,
  ghidraVersion: (ghidra, jdk) => `Ghidra ${ghidra} · Temurin JDK ${jdk}`,
  sizes: (download, installed) => `Download ${download} · Installiert ${installed}`,
  total: (download, installed) =>
    `Gesamt: Download ${download}, installiert ${installed}`,
  ownToolsLabel: "Deine eigenen Tools",
  ownToolsDescription:
    "AgentPier lädt Hopper, IDA und JEB nie herunter. Wenn du sie hast, kann REA sie über diese Einstellungen nutzen. Lass ein Feld leer, um es nicht zu nutzen.",
  hopperPath: "Pfad zum Hopper-Launcher",
  idaConfig: "Konfiguration der IDA-MCP-Brücke",
  jebUrl: "JEB-MCP-URL",
  provider: "Analyseanbieter",
  providerHint: "IDA braucht den Pfad zur Konfiguration der IDA-MCP-Brücke.",
  safetyLabel: "Sicherheit",
  safetyDualUse:
    "REA ist Dual Use: Die Tools, die Software erklären, helfen auch, sie zu knacken. Analysiere nur Software, die du analysieren darfst.",
  safetyDisclaimer:
    "REAs DISCLAIMER verbietet, DRM, Lizenzprüfungen und Anti-Cheat-Systeme zu umgehen.",
  safetyUntrusted:
    "Öffne nicht vertrauenswürdige Binärdateien nur in einer virtuellen Maschine oder einem eigenen Benutzerkonto, nie neben deinen eigenen Daten.",
  safetyGenuine:
    "Nur morluto/rea ist das echte REA. Kopien unter anderen Namen stammen nicht von seinem Autor.",
  sandboxLabel: "Sandbox",
  sandboxNotice:
    "REA wird in der nono-Sandbox nicht unterstützt. Diese Funktionen brauchen eine Session ohne Sandbox:",
  sandboxGhidra: "Dekompilieren mit Ghidra",
  sandboxFrida: "Frida: an Prozesse anhängen und Prozesse starten",
  sandboxLldb: "Debuggen mit LLDB",
  sandboxProcesses: "Prozesse auflisten",
  sandboxBridges: "Die Brücken zu Hopper, IDA und JEB",
  acknowledge:
    "Ich habe diese Hinweise verstanden und nutze REA nur für Software, die ich analysieren darf.",
  applyChanges: "Änderungen übernehmen",
  update: "Aktualisieren",
  updateNote: (version) => `Eine neuere REA-Version ist verfügbar: ${version}.`,
  statusRunning: "REA wird geändert …",
  statusFailed: "Die letzte Änderung ist fehlgeschlagen",
  statusSucceeded: "Fertig",
  backgroundNote:
    "Du kannst dieses Fenster schließen. REA arbeitet im Hintergrund weiter.",
  uninstall: "REA deinstallieren",
  uninstallTitle: "REA deinstallieren?",
  uninstallBody:
    "AgentPier entfernt REAs MCP-Server, seine Skill-Kopien, Ghidra, die Java-Laufzeit und Frida. Dein eigenes Hopper, IDA und JEB bleiben unberührt.",
  uninstallConfirm: "Deinstallieren",
};
