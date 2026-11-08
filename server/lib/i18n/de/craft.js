/** German messages of the managed Craft Anything tool. */
export const craft = Object.freeze({
  platformUnavailable:
    "Craft Anything gibt es nur für macOS und Linux auf arm64 oder x64.",
  downloading: (percent) => `Craft Anything wird geladen … ${percent} %`,
  unpacking: "Craft Anything wird entpackt …",
  checking: "Craft Anything wird geprüft …",
  layoutInvalid: "Das geladene Craft Anything hat nicht den erwarteten Aufbau.",
  notStarting: "Das geladene Craft Anything startet nicht.",
  versionMismatch: (expected, actual) =>
    `Das geladene Craft Anything meldet Version ${actual} statt ${expected}.`,
  invalidMode: "Der Modus von Craft Anything muss „clean-room“ oder „deep“ sein.",
  busy: "Craft Anything wird gerade installiert, geändert oder entfernt. Warte, bis das fertig ist.",
  inUse:
    "Craft Anything läuft gerade in einer Session. Beende sie, bevor du Craft Anything oder seine Bestandteile entfernst, änderst oder aktualisierst.",
  confirmationRequired: "Bestätige zuerst die Installation von Craft Anything.",
  notInstalled: "Craft Anything ist nicht installiert.",
  rowBroken:
    "Der MCP-Server von Craft Anything ist beschädigt. Entferne Craft Anything und installiere es erneut.",
  installing: "Craft Anything wird installiert …",
  removing: (name) => `${name} für Craft Anything wird entfernt …`,
  configuring: "Die Umgebung von Craft Anything wird eingerichtet …",
  copyingSkill: "Der Skill von Craft Anything wird in die CLIs kopiert …",
  failed: "Craft Anything konnte nicht installiert oder geändert werden.",
});
