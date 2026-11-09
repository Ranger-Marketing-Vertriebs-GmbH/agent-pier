/** Copy of agent cards (agent-cards.js): CARD_* problems and the Telegram fallback. */
export const agentCards = Object.freeze({
  CARD_INVALID: (detail) =>
    `Die Karte wurde abgelehnt (${detail}). Korrigiere diesen Teil und rufe agentpier_card erneut auf; die Werkzeugbeschreibung nennt die Bausteine und ihre Grenzen.`,
  CARD_TOO_LARGE: (max) =>
    `Die Karte ist größer als ${max} Bytes. Kürze ihre Texte oder teile sie auf zwei Karten auf.`,
  CARD_NOT_FOUND:
    "Diese Karte gibt es in diesem Chat nicht. Rufe agentpier_card mit der Aktion read ohne cardId auf, um die Karten dieses Chats zu sehen.",
  CARD_FROZEN:
    "Diese Karte ist eingefroren: Der Chat hat neuere Karten, und nur die neuesten 30 bleiben offen. Erstelle stattdessen eine neue Karte.",
  CARD_CHANGED: "Die Karte hat sich inzwischen geändert. Sieh sie dir noch einmal an.",
  CARD_UNAVAILABLE:
    "Karten sind in diesem Lauf nicht verfügbar: Nur eigene Chat-Züge, Routinen und Hooks eines Agenten dürfen Karten anlegen oder ändern, und nur in ihrem eigenen Chat. Nicht erneut versuchen; antworte mit Text.",
  telegram: Object.freeze({
    open: "Öffne den Chat in AgentPier, um diese Karte zu nutzen.",
    more: (count) => `… ${count} weitere`,
    chart: (count) => `Diagramm (${count} Werte)`,
  }),
});
