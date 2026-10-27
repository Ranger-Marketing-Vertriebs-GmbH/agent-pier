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
});
