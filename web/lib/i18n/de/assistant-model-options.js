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
  member: {
    label: "Folgt dem leitenden Agenten",
    sub: "Ein temporäres Teammitglied arbeitet mit der Denkstufe, dem Schnellmodus und dem Schleifenschutz seines leitenden Agenten.",
  },
  search: {
    thinking: "Denkstufe",
    fast: "Schnellmodus",
    effort: "Denkaufwand",
    loop: "Schleifenschutz",
  },
};
