// Wie das Modell eines OpenClaw-Agenten arbeitet (Reiter Identität, unter dem Modell):
// die eigene Fläche der Laufzeit (web/features/assistants/runtimes/openclaw/).
export const assistantModelOptionsCopy = {
  title: "Modellverhalten",
  hint: "Wie das Modell dieses Agenten arbeitet. Steht eine Einstellung auf „Standard“, gelten die Einstellung für alle Agenten und der Standard des Modells.",
  inherit: "Standard",
  thinking: {
    label: "Denkstufe",
    sub: "Wie gründlich das Modell nachdenkt, bevor es antwortet. Kennt das Modell eine Stufe nicht, gilt die nächstpassende.",
  },
  fast: {
    label: "Schnellmodus",
    sub: "Bittet den Anbieter um schnellere Antworten, wo er das anbietet, etwa die bevorzugte Verarbeitung bei OpenAI und Anthropic. Das kann mehr kosten; andere Modelle ignorieren es.",
    on: "An",
    off: "Aus",
  },
  loop: {
    label: "Schleifenschutz",
    sub: "Beendet einen Auftrag, in dem das Modell denselben Tool-Aufruf immer wieder wiederholt, ohne voranzukommen. Standardmäßig an bei einem Modell deines eigenen Endpunkts, das oft ein kleines oder lokales Modell ist.",
  },
  fallback: {
    label: "Ersatzmodelle",
    sub: "Kann das Modell dieses Agenten nicht antworten, beantwortet das erste Ersatzmodell, das es kann, dieselbe Nachricht, in dieser Reihenfolge: sofort, wenn ein Schlüssel abgelehnt wird oder es das Modell nicht mehr gibt, und nach den Wiederholungen bei einem gestörten Anbieter oder einem Ratenlimit, was einige Minuten dauern kann. Die nächste Nachricht versucht zuerst wieder das eigene Modell des Agenten. Der Anbieter eines Ersatzmodells erhält dann die Unterhaltung; ein Ersatzmodell, das keine Bilder annimmt, antwortet ohne sie.",
    none: "Keine",
    connection: (number) => `Ersatzmodell ${number}: Zugang`,
    model: (number) => `Ersatzmodell ${number}: Modell`,
    modelId: (number) => `Ersatzmodell ${number}: Modell-ID`,
    chooseConnection: "Zugang wählen",
    chooseModel: "Modell wählen",
    add: "Ersatzmodell hinzufügen",
    remove: (number) => `Ersatzmodell ${number} entfernen`,
    incomplete: "Wähle einen Zugang und ein Modell.",
    ownModel: "Das ist das eigene Modell des Agenten. Wähle ein anderes.",
    incompleteSave:
      "Wähle für jedes Ersatzmodell einen Zugang und ein Modell oder entferne es, um zu speichern.",
    twiceSave: "Jedes Ersatzmodell muss ein anderes Modell sein.",
    leftOut: (reason) => `Ausgelassen, bis es wieder verfügbar ist: ${reason}`,
    reasons: {
      kind: "Eine ChatGPT-Anmeldung kann kein Ersatzmodell sein",
      unavailable: "Nicht verfügbar",
      missing: "Diesen Zugang gibt es nicht mehr",
    },
  },
  member: {
    label: "Folgt dem leitenden Agenten",
    sub: "Ein temporäres Teammitglied arbeitet mit der Denkstufe, dem Schnellmodus, dem Schleifenschutz und den Ersatzmodellen seines leitenden Agenten.",
  },
  search: {
    thinking: "Denkstufe",
    fast: "Schnellmodus",
    effort: "Denkaufwand",
    loop: "Schleifenschutz",
    fallback: "Ersatzmodelle",
    failover: "Ausweichmodell",
    backup: "Reservemodell",
  },
};
