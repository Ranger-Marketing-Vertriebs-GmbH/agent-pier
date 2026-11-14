// Coding-Sessions und Agenten im Gespräch, wie der Chat des Agenten es zeigt.
export const sessionTalkCopy = {
  chat: {
    asks: (session, project) => `Session ${session} (Projekt ${project}) fragt`,
    tells: (session, project) => `Session ${session} (Projekt ${project}) teilt mit`,
    noProject: "kein Projekt",
    sentTo: (session, project) => `Nachricht an Session ${session} (Projekt ${project})`,
    lateTo: (session, project) =>
      `Späte Antwort an Session ${session} (Projekt ${project})`,
    lateDropped: (session) =>
      `Späte Antwort an Session ${session} wurde nicht zugestellt`,
    limit: (session) =>
      `Zu viele Nachrichten mit Session ${session}: weitere werden vorerst zurückgehalten`,
    outcome: {
      accepted: "angenommen",
      pending: "ausstehend",
      rejected: "abgelehnt",
      dropped: "verworfen",
    },
  },
  // Der Dialog „Agentenzugriff“ einer Session.
  dialog: {
    title: "Agentenzugriff",
    summary: "Wähle die Agenten, mit denen diese Session sprechen darf.",
    hint: "Agenten, die du hier ankreuzt, dürfen dieser Session schreiben, und die Session darf sie fragen und ihnen etwas mitteilen. Der Zugriff endet, wenn die Session stoppt.",
    projectHint:
      "Agenten mit „Sessions dürfen sprechen“ für das Projekt dieser Session sind schon angekreuzt; das änderst du im Tab Zugriff des Agenten.",
    viaProject: "über das Projekt",
    empty: "Noch keine Agenten. Lege einen unter Agenten an.",
    loading: "Agenten werden geladen …",
    busy: "Wird gespeichert …",
    saved: "Gespeichert.",
    tools: {
      ready: "Kann Agenten fragen",
      missing:
        "Läuft ohne AgentPier-Tools: Agenten können ihr schreiben, aber sie kann sie nicht fragen; starte dafür eine neue Session mit AgentPier-Toolsn",
    },
  },
  // Die Agentenauswahl im Dialog für eine neue Session.
  launch: {
    title: "Agenten",
    hint: "Die Session darf die angekreuzten Agenten fragen und ihnen etwas mitteilen, und sie dürfen ihr schreiben, bis sie stoppt.",
    summary: (count) => `${count} ${count === 1 ? "Agent" : "Agenten"}`,
  },
};
