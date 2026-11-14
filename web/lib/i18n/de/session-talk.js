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
};
