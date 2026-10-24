// Das Arbeitsziel eines Agenten im Chat seines Besitzers: das offene Ziel mit Stoppen
// und seine Hinweise.
export const workGoalCopy = {
  line: (t) => `Arbeitet bis fertig: ${t}`,
  stop: "Stoppen",
  stopFailed: "Das Ziel ließ sich nicht stoppen. Versuche es erneut.",
  // Eine Runde, die AgentPier schickt, damit der Agent am Ziel weiterarbeitet.
  continuing: (t) => `Macht weiter · ${t}`,
  notes: {
    set: (t) => `Arbeitet bis fertig: ${t}`,
    done: (t) => `Ziel erreicht: ${t}`,
    blocked: (t) => `Ziel blockiert: ${t}`,
    stopped: (t) => `Ziel gestoppt: ${t}`,
    replaced: (t) => `Ziel ersetzt: ${t}`,
    ended: (t) => `Ziel beendet: ${t}`,
  },
  // Warum AgentPier ein Ziel von sich aus beendet hat.
  reasons: {
    technical: "Das Modell ist mehrmals hintereinander gescheitert.",
    "no-progress": "Mehrere Fortsetzungen brachten keinen Fortschritt.",
    proof: "Deine Nachricht, die das Ziel gesetzt hat, ist nicht mehr verfügbar.",
    archived: "Der Chat oder der Agent wurde archiviert.",
    ineligible: "Dieser Agent kann keine Ziele mehr verfolgen.",
    "turn-cancelled": "Du hast die Antwort des Agenten gestoppt.",
  },
};
