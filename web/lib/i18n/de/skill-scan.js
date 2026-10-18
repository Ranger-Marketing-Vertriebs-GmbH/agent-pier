export const skillScanCopy = {
  checkAction: "Skill prüfen",
  checking: "Skill wird geprüft …",
  previewTitle: "Prüfergebnis",
  backAction: "Zurück",
  verdicts: {
    ok: "Unauffällig",
    warn: "Hinweise",
    block: "Blockiert",
  },
  verdictDescriptions: {
    ok: "Die Prüfung hat nichts Auffälliges gefunden.",
    warn: "Die Prüfung hat Stellen gefunden, die du vor der Installation ansehen solltest.",
    block:
      "Die Prüfung hat riskante Inhalte gefunden. Der Skill wird deshalb nicht normal installiert.",
  },
  offlineNote:
    "AgentPier prüft die Dateien offline und führt dabei nichts aus. Installiert wird genau der geprüfte Inhalt.",
  nameLabel: "Skill",
  sourceLabel: "Quelle",
  filesLabel: "Dateien",
  filesSummary: (count, size) => `${count} Dateien · ${size} KiB`,
  importKinds: {
    zip: "ZIP-Datei",
    "skill-md": "SKILL.md",
    github: "GitHub",
  },
  findingsHeading: "Funde",
  findingsFor: (file) => `Funde in ${file}`,
  severities: {
    warn: "Hinweis",
    block: "Blockiert",
  },
  line: (number) => `Zeile ${number}`,
  wholeFile: "Ganze Datei",
  truncated: "Weitere Funde derselben Art wurden ausgelassen.",
  rules: {
    "download-exec": "Lädt Code herunter und führt ihn aus",
    "credential-exfiltration": "Liest Zugangsdaten und sendet Daten",
    "bidi-control": "Unsichtbare Steuerzeichen für die Textrichtung",
    "unicode-tag": "Unsichtbare Unicode-Tag-Zeichen",
    "invisible-character": "Unsichtbare Zeichen",
    "prompt-injection": "Formulierung, die Anweisungen ersetzen will",
    "encoded-blob": "Langer kodierter Datenblock",
    "executable-file": "Ausführbare Datei",
    "binary-executable": "Ausführbares Programm (Binärdatei)",
  },
  ruleHints: {
    "download-exec":
      "Ein Download wird direkt an eine Shell oder einen Interpreter übergeben oder ausführbar gemacht.",
    "credential-exfiltration":
      "Dieselbe Datei nennt Pfade mit Zugangsdaten (etwa ~/.ssh, .env, ~/.aws, Schlüsselbund) und Netzwerkaufrufe.",
    "bidi-control":
      "Diese Zeichen können Text anders anzeigen, als er gelesen wird. Sie sind hier als <U+…> sichtbar gemacht.",
    "unicode-tag":
      "Tag-Zeichen sind unsichtbar und können versteckte Anweisungen tragen. Sie sind hier als <U+…> sichtbar gemacht.",
    "invisible-character":
      "Nullbreite Zeichen können Wörter tarnen oder Text verstecken. Sie sind hier als <U+…> sichtbar gemacht.",
    "prompt-injection":
      "Der Text versucht, frühere Anweisungen aufzuheben oder Aktionen vor dir zu verbergen.",
    "encoded-blob":
      "Ein langer Base64- oder Hex-Block kann Inhalte verbergen, die du nicht lesen kannst.",
    "executable-file":
      "Die Datei behält ihr Ausführungsrecht. Eine CLI kann sie später starten.",
    "binary-executable":
      "Die Datei enthält Maschinencode, den du vor der Installation nicht lesen kannst.",
  },
  acceptWarnings: "Ich habe die Hinweise geprüft und möchte den Skill installieren.",
  overrideAction: "Trotzdem installieren …",
  overrideTitle: "Blockierten Skill trotzdem installieren?",
  overrideRisks: "Die Prüfung hat diesen Skill blockiert wegen:",
  overrideNote:
    "Installiere ihn nur, wenn du der Quelle vertraust und jeden Fund geprüft hast. Die Ausnahme wird im Audit-Protokoll vermerkt.",
  overrideConfirm: "Risiko akzeptieren und installieren",
};
