// Das Memory-Wiki eines OpenClaw-Agenten (Tab Fähigkeiten und seine Leseseite, ADR 0007
// Schritt 7b): Oberflächen der Laufzeit selbst (web/features/assistants/runtimes/openclaw/).
export const assistantMemoryWikiCopy = {
  title: "Memory-Wiki",
  switch: "Memory-Wiki führen",
  hint: "Der Agent führt neben seinen Gedächtnisnotizen ein Wiki aus Seiten mit Quellen und Aussagen.",
  description:
    "Der Agent schreibt sein Wiki selbst während seiner Durchläufe, mit fünf Wiki-Tools, und seine Gedächtnisnotizen (MEMORY.md, seine Tagesnotizen und Traumberichte) werden als Quellseiten übernommen. Keine zusätzlichen Modellaufrufe: Das Wiki wird ohne Modell zusammengestellt. Das erste eingeschaltete Wiki startet den Agentendienst neu.",
  locked: {
    shared:
      "Nur deine eigenen Agenten können ein Memory-Wiki führen, kein mit Nutzern geteilter Agent.",
    userAgent:
      "Nur deine eigenen Agenten können ein Memory-Wiki führen, nicht der eigene Agent eines Nutzers.",
    taskMember:
      "Nur deine eigenen Agenten können ein Memory-Wiki führen, kein temporäres Teammitglied.",
    channelBot:
      "Ein Agent, dessen eigener Telegram-Bot anderen Menschen dient, kann kein Memory-Wiki führen, denn deren Nachrichten würden dauerhafte Seiten schreiben.",
  },
  open: "Wiki lesen",
  openHint: "Seine Seiten, nur lesend",
  page: {
    pages: "Seiten",
    empty:
      "Noch keine Seiten. Der Agent legt Seiten mit seinen Wiki-Tools während seiner Durchläufe an.",
    building: "Das Wiki wird gerade zusammengestellt. Es erscheint gleich.",
    count: (shown, total) => `${shown} von ${total} Seiten aufgeführt`,
    truncated: "Nur die neuesten Seiten werden aufgeführt.",
    updated: (time) => `Aktualisiert ${time}`,
    back: "Alle Seiten",
    cut: "Diese Seite ist lang; nur ihr Anfang wird gezeigt.",
    loading: "Wiki wird geladen …",
    unavailable: "Das Wiki lässt sich gerade nicht lesen.",
    kinds: {
      synthesis: "Synthese",
      entity: "Entität",
      concept: "Konzept",
      source: "Quelle",
      report: "Bericht",
    },
  },
  search: {
    wiki: "Wiki",
    knowledge: "Wissens-Wiki",
  },
};
