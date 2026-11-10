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
    "Gerade läuft ein Nachbau mit Craft Anything. Warte, bis er fertig ist, oder pausiere ihn, bevor du Craft Anything oder seine Bestandteile entfernst, änderst oder aktualisierst.",
  confirmationRequired: "Bestätige zuerst die Installation von Craft Anything.",
  notInstalled: "Craft Anything ist nicht installiert.",
  rowBroken:
    "Der MCP-Server von Craft Anything ist beschädigt. Entferne Craft Anything und installiere es erneut.",
  installing: "Craft Anything wird installiert …",
  removing: (name) => `${name} für Craft Anything wird entfernt …`,
  configuring: "Die Umgebung von Craft Anything wird eingerichtet …",
  copyingSkill: "Der Skill von Craft Anything wird in die CLIs kopiert …",
  failed: "Craft Anything konnte nicht installiert oder geändert werden.",
  rebuildRequestRequired: "Beschreibe, was Craft Anything nachbauen soll.",
  rebuildRequestTooLong:
    "Die Beschreibung des Nachbaus ist zu lang (höchstens 8000 Zeichen).",
  rebuildTargetInvalid:
    "Das Ziel eines Nachbaus muss eine Webadresse (http oder https), ein absoluter Pfad oder leer sein.",
  rebuildTargetPathRefused:
    "Ein Agent kann nur eine Webadresse (http oder https) oder nichts nachbauen lassen, keinen lokalen Pfad.",
  rebuildStackInvalid: "Craft Anything kennt diesen Stack nicht.",
  rebuildRoundsInvalid:
    "Die Runden eines Nachbaus müssen eine ganze Zahl von 1 bis 10 sein.",
  rebuildAccountIneligible:
    "Dieses Konto kann keinen Nachbau ausführen. Wähle ein eigenes Claude-Konto ohne Provider.",
  rebuildToolInvalid:
    "Ungültige Eingabe. Ein Nachbau braucht eine Beschreibung und eine requestId (höchstens 100 Zeichen).",
  rebuildNotFound: "Diesen Nachbau gibt es nicht.",
  rebuildRunning: "Dieser Nachbau läuft gerade. Pausiere ihn zuerst.",
  rebuildNeverStarted:
    "Dieser Nachbau wurde nie gestartet und kann nicht fortgesetzt werden.",
  rebuildAnswerInvalid:
    "Eine Antwort braucht die Frage und eine Auswahl, einen Text oder eine Freigabe.",
  rebuildQuestionGone: "Diese Frage ist schon beantwortet oder nicht mehr offen.",
  rebuildAutoModeInvalid: "Der Automodus muss ein- oder ausgeschaltet werden.",
  rebuildSettingsInvalid:
    "Die Voreinstellungen für Nachbauten brauchen ein Konto, „clean-room“ oder „deep“ und einen Automodus.",
  rebuildsStopping: "AgentPier wird beendet. Neue Nachbauten starten erst danach wieder.",
  rebuildUnavailable: (detail) =>
    `Craft Anything konnte den Nachbau nicht ausführen: ${detail}`,
});
