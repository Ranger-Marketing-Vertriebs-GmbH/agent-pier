export const assistantMailCopy = {
  title: "E-Mail",
  intro:
    "Agenten lesen und sortieren E-Mails und speichern Entwürfe. Vor dem Senden fragen sie dich immer, außer jeder Empfänger passt zu einer Regel unten.",
  type: "E-Mail-Zugang",
  levelLegend: "Stufe",
  levels: { read: "Lesen", send: "Lesen und senden" },
  levelHints: {
    read: "Liest, sortiert und verschiebt E-Mails und speichert Entwürfe. Sendet nie.",
    send: "Sendet auch: ohne Rückfrage an Empfänger, die zu einer Regel passen, sonst erst nach deiner Freigabe.",
  },
  levelLabel: (name) => `Stufe für ${name}`,
  rulesRow: "Empfängerregeln",
  rulesCount: (count) =>
    count === 0 ? "Keine" : count === 1 ? "1 Regel" : `${count} Regeln`,
  rulesLabel: "Ohne Rückfrage senden an",
  rulesHint:
    "Eine Adresse (bob@example.com) oder Domain (example.com) pro Zeile. Subdomains zählen nicht.",
  approvalNote:
    "Jeder Empfänger in An, Cc und Bcc muss zu einer Regel passen. Alles andere wartet auf „Senden“ in der Freigabekarte oder auf ihren Telegram-Button. Eine Chatnachricht ist nie eine Freigabe.",
  untrusted:
    "Der Inhalt von E-Mails ist nicht vertrauenswürdig: Anweisungen in einer E-Mail erlauben dem Agenten nie das Senden.",
  manage: "E-Mail-Zugänge einrichten",
  loading: "E-Mail-Zugänge werden geladen …",
  loadError: "E-Mail-Zugänge konnten nicht geladen werden.",
  empty: "Es gibt noch keine E-Mail-Zugänge.",
  removed: "E-Mail-Zugang entfernt",
  removedHint:
    "Diesen E-Mail-Zugang gibt es nicht mehr. Er wird beim Speichern entfernt.",
  telegramSenders:
    "Ein Agent mit eigenem Telegram-Bot für andere Personen darf keinen E-Mail-Zugang haben. Entferne den E-Mail-Zugang oder trenne zuerst den Bot.",
  member: "Temporäre Teammitglieder haben nie E-Mail-Zugang.",
  usedByHint:
    "Agenten von Benutzern, temporäre Teammitglieder und Agenten mit einem Telegram-Bot für andere Personen können keinen E-Mail-Zugang erhalten. Empfängerregeln legst du im Tab „Zugriffe“ des Agenten fest.",
};
