/** German messages of the managed REA tool (reverse engineering for agents). */
export const rea = Object.freeze({
  downloadFailed: "Ein REA-Bestandteil konnte nicht geladen werden.",
  checksumMismatch:
    "Ein geladener REA-Bestandteil stimmt nicht mit seiner festgelegten Prüfsumme überein.",
  forbiddenRedirect: "Der REA-Download wurde zu einem nicht erlaubten Ziel umgeleitet.",
  redirectLimit: "Der REA-Download wurde zu oft umgeleitet.",
  platformUnavailable: "REA gibt es nur für macOS und Linux auf arm64 oder x64.",
  ghidraMacosTooOld: "Ghidra für REA braucht macOS 15 (Sequoia) oder neuer.",
  ghidraIntelMac:
    "Ghidra für REA gibt es auf Intel-Macs noch nicht; REA Core und frida lassen sich installieren.",
  ghidraLinuxArm64:
    "Ghidra für REA gibt es auf Linux arm64 noch nicht; REA Core und frida lassen sich installieren.",
  fridaUnavailable: "frida für REA gibt es auf dieser Plattform nicht.",
  downloading: (name, percent) => `${name} für REA wird geladen … ${percent} %`,
  unpacking: (name) => `${name} für REA wird entpackt …`,
  checking: (name) => `${name} für REA wird geprüft …`,
  layoutInvalid: (name) => `Das geladene ${name} hat nicht den erwarteten Aufbau.`,
  ghidraVersionMismatch: (version) =>
    `Das entpackte Ghidra ist nicht Version ${version}.`,
  ghidraDecompilerMissing:
    "Dem entpackten Ghidra fehlt der native Decompiler für diese Plattform.",
  ghidraMissingLibraries: (libraries) =>
    `Dem Decompiler von Ghidra fehlen Systembibliotheken: ${libraries}.`,
  jdkNotStarting: "Die Java-Laufzeit für REA startet nicht.",
  jdkVersionMismatch: (version) =>
    `Die Java-Laufzeit für REA meldet nicht Version ${version}.`,
  diskFull: "Für diesen REA-Bestandteil ist nicht genug Speicherplatz frei.",
  fridaFailed: "frida für REA konnte nicht installiert werden oder lädt nicht.",
  invalidPath:
    "Gib für diese REA-Einstellung einen absoluten Pfad ohne Steuerzeichen an.",
  invalidJebUrl:
    "Die JEB-MCP-URL muss eine http- oder https-URL ohne Zugangsdaten und Fragment sein.",
  idaConfigRequired:
    "Der Analyseanbieter IDA braucht den Pfad zu einer IDA-MCP-Konfiguration.",
  invalidProvider: "REAs Analyseanbieter muss Ghidra oder IDA sein.",
  busy: "REA wird gerade installiert, geändert oder entfernt. Warte, bis das fertig ist.",
  inUse:
    "REA läuft gerade in einer Session oder bei einem Agenten. Beende sie, bevor du REAs Bestandteile entfernst, änderst oder aktualisierst.",
  confirmationRequired: "Bestätige zuerst die Installation von REA.",
  notInstalled: "REA ist nicht installiert.",
  rowBroken:
    "Der MCP-Server von REA hat kein installiertes REA Core. Entferne REA und installiere es erneut.",
  installingCore: "REA Core wird installiert …",
  removing: (name) => `${name} für REA wird entfernt …`,
  configuring: "REAs Umgebung wird eingerichtet …",
  copyingSkill: "REAs Skill wird in die CLIs kopiert …",
  coreFailed: "REA Core konnte nicht installiert werden.",
  failed: "REA konnte nicht installiert oder geändert werden.",
});
