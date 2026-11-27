// Wie das Modell eines OpenClaw-Agenten arbeitet (Reiter Identität, unter dem Modell):
// die eigene Fläche der Laufzeit (web/features/assistants/runtimes/openclaw/).
export const assistantModelOptionsCopy = {
  title: "Denken und Tempo",
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
  member: {
    label: "Folgt dem leitenden Agenten",
    sub: "Ein temporäres Teammitglied arbeitet mit der Denkstufe und dem Schnellmodus seines leitenden Agenten.",
  },
  search: {
    thinking: "Denkstufe",
    fast: "Schnellmodus",
    effort: "Denkaufwand",
  },
};
