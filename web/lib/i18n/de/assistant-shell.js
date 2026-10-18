export const assistantShellCopy = {
  title: "Shell-Zugriff",
  intro: "Erlaubt dem Agenten, Kommandozeilenprogramme auf diesem Computer auszuführen.",
  levels: {
    off: "Aus",
    approval: "Mit Freigabe",
    full: "Voller Zugriff",
  },
  levelHints: {
    off: "Der Agent kann keine neuen Befehle ausführen. Bereits im Hintergrund gestartete Befehle laufen weiter, bis sie enden; unter Linux beendet sie auch ein Neustart des Agentendienstes.",
    approval: "Der Agent fragt dich vor jedem Befehl, der nicht immer erlaubt ist.",
    full: "Der Agent führt jeden Befehl aus, ohne dich zu fragen.",
  },
  offHint:
    "Ohne Shell-Zugriff funktionieren Skills und Tools nicht, die Kommandozeilenprogramme brauchen, zum Beispiel gh, git oder Mail-Programme.",
  warning:
    "Mit Shell-Zugriff arbeitet der Agent als dein Benutzerkonto: mit deinen Anmeldungen, deinen Dateien und deinen Schlüsseln, und er kann AgentPiers eigene Daten lesen. Der Schreibschutz für Teams gilt nicht für Shell-Befehle.",
  temporary:
    "Auftragsgebundene Teammitglieder bekommen Shell-Zugriff nur, wenn ihr leitender Agent es unter Arbeit erlaubt, und höchstens mit seiner Stufe.",
  archived: "Archivierte Agenten haben keinen Shell-Zugriff.",
  pending: "Die neue Shell-Stufe gilt, sobald der Agentendienst wieder läuft.",
  badge: {
    approval: "Shell: Freigabe",
    full: "Shell: voll",
  },
  badgeLabel: (level) => `Shell-Zugriff: ${level}`,
  confirmTitle: "Shell-Zugriff einschalten?",
  confirm: "Shell-Zugriff einschalten",
  fullTitle: "Jeden Befehl ohne Rückfrage ausführen?",
  fullBody:
    "Mit vollem Zugriff gibt es überhaupt keine Rückfragen: Der Agent führt jeden Befehl sofort aus, auch Befehle, die Dateien löschen oder Daten versenden. Du kannst einen Befehl nicht vorher stoppen.",
  confirmFull: "Ohne Rückfragen erlauben",
  allowlist: "Immer erlaubte Befehle",
  allowlistHint:
    "Programme und Befehle, die du mit „Immer erlauben“ freigegeben hast. Löschst du einen Eintrag, fragt der Agent wieder.",
  allowlistEmpty: "Keine immer erlaubten Befehle.",
  allowlistLoading: "Erlaubte Befehle werden geladen …",
  sources: {
    agentpier: "Von AgentPier eingetragen",
    openclaw: "Von OpenClaw eingetragen",
    other: "Anderswo eingetragen",
  },
  anyArguments: "Mit beliebigen Argumenten",
  exactArguments: "Nur mit den freigegebenen Argumenten im freigegebenen Ordner",
  commandEntry: "Genauer Befehl",
  command: "Befehl",
  folder: "Ordner",
  lastUsed: (time) => `Zuletzt verwendet ${time}`,
  linked: (count) => `Verknüpfte Befehlseinträge: ${count}`,
  remove: "Löschen",
  removeLabel: (pattern) => `Eintrag ${pattern} entfernen`,
  removeTitle: (pattern) => `Eintrag ${pattern} entfernen?`,
  removeBody: "Der Agent fragt vor diesem Befehl wieder nach einer Freigabe.",
  removeNow: "Jetzt entfernen",
  exec: {
    history: "Shell-Befehl",
    title: "Shell-Befehl wartet auf Freigabe",
    agent: "Agent",
    folder: "Ordner",
    expires: (time) => `Läuft ab ${time}`,
    showFull: "Ganzen Befehl zeigen",
    showLess: "Weniger zeigen",
    allowOnce: "Einmal erlauben",
    allowAlways: "Immer erlauben",
    deny: "Ablehnen",
    note: "Hinweise von OpenClaw",
    alwaysPrograms: (programs) =>
      `„Immer erlauben“ lässt diesen Agenten diese Programme ab jetzt ohne Rückfrage ausführen, jeweils mit beliebigen Argumenten: ${programs}. Manche Programme können über ihre Argumente andere Befehle ausführen, etwa Git-Hooks oder Aliase; „Immer erlauben“ deckt das mit ab. Du kannst die Einträge in den Agenteneinstellungen löschen.`,
    writable: (programs) =>
      `In Ordnern, in die du schreiben kannst, liegen: ${programs}. Wird eines davon geändert oder ersetzt, führt der Agent die neue Version ohne Nachfrage aus. Befehle mit Umleitungen (> oder <) lehnt OpenClaw für solche Programme immer ab.`,
    alwaysOnce: (reason) =>
      `„Immer erlauben“ erlaubt diesen Befehl nur einmal: ${reason}. Diese Art Befehl fragt beim nächsten Mal wieder.`,
    confirmAlways: "Diese Programme immer erlauben",
    back: "Zurück",
    onceReasons: {
      interpreter: (program) =>
        `${program} ist ein Interpreter, eine Shell oder ein Starter`,
      inline: (program) => `${program} führt ein Inline-Skript aus`,
      unresolved: (program) =>
        `AgentPier kann ${program} keinem festen Programmpfad zuordnen`,
    },
    onceCommandReasons: {
      inline: "der Befehl führt ein Inline-Skript aus",
      unresolved: "AgentPier kann den Befehl keinem festen Programm zuordnen",
      complex:
        "der Befehl nutzt Shell-Syntax, die AgentPier keinen festen Programmen zuordnen kann, etwa Variablen, Umgebungszuweisungen, Befehlsersetzung, Subshells, Kontrollstrukturen oder Hintergrundjobs",
    },
  },
};
