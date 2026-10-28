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
    count === 0 ? "Keine Regeln" : count === 1 ? "1 Regel" : `${count} Regeln`,
  rulesLabel: "Ohne Rückfrage senden an",
  rulesHint:
    "Eine Adresse (bob@example.com) oder Domain (example.com) pro Zeile. Subdomains zählen nicht.",
  approvalNote:
    "Jeder Empfänger in An, Cc und Bcc muss zu einer Regel passen. Alles andere wartet auf „Senden“ in der Freigabe oder auf deren Telegram-Button. Eine Chatnachricht ist nie eine Freigabe.",
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
  usedByHint:
    "Agenten von Benutzern, temporäre Teammitglieder und Agenten mit einem Telegram-Bot für andere Personen können keinen E-Mail-Zugang erhalten. Empfängerregeln legst du im Tab „Zugriffe“ des Agenten fest.",
  invalidRule: (rule) =>
    `„${rule}“ ist keine Adresse oder Domain. Nutze bob@example.com oder example.com, ohne Namen oder Platzhalter.`,
  tooManyRules: (max) => `Höchstens ${max} Regeln pro E-Mail-Zugang.`,
  rulesInvalid: (name) => `Korrigiere die Empfängerregeln von ${name}, um zu speichern.`,
  card: {
    title: "E-Mail senden?",
    agent: "Agent",
    account: "E-Mail-Zugang",
    from: "Von",
    to: "An",
    cc: "Cc",
    bcc: "Bcc",
    subject: "Betreff",
    noSubject: "(kein Betreff)",
    body: "Nachricht",
    send: "Senden",
    decline: "Nicht senden",
    states: {
      awaiting_approval: "Wartet auf dich",
      executing: "Wird gesendet …",
      completed: "Gesendet",
      declined: "Nicht gesendet · Entwurf bleibt",
      expired: "Abgelaufen · Entwurf bleibt",
      cancelled: "Abgebrochen",
      failed: "Senden fehlgeschlagen",
      unknown: "Unklar, ob gesendet · vor erneutem Versuch Gesendet prüfen",
    },
    attachments: "Anhänge",
    forwardOf: "Weiterleitung von",
    inDraft: "Schon im Entwurf",
    fromOriginal: "Aus der ursprünglichen E-Mail",
    fromAgentDraft: (agent) => `aus dem Entwurf von ${agent}`,
    unnamed: "(ohne Namen)",
    hash: "SHA-256",
    html: {
      kept: "Enthält die HTML-Fassung des Originals, die hier nicht angezeigt wird.",
      omitted:
        "Die HTML-Fassung des Originals bleibt weg; nur der Text wird weitergeleitet.",
      draft: "Enthält eine HTML-Fassung, die hier nicht angezeigt wird.",
    },
    hidden: "Enthält versteckte Zeichen. Sie werden als Codes gezeigt.",
    showAll: "Alles zeigen",
    showLess: "Weniger zeigen",
    expandFirst: "Zeige die ganze Nachricht, bevor du sie sendest.",
    expires: (time) => `Läuft ab: ${time}`,
    onlyButtons:
      "Nur Senden hier oder in Telegram verschickt diese E-Mail. Eine Chatnachricht nie.",
  },
  note: {
    label: "E-Mail",
    account: "E-Mail-Zugang",
    recipients: "Empfänger",
    code: "Code",
  },
};
