/* global self */
// Deutsche Hinweistexte; public/pwa-en.js hat dieselben Schlüssel.
self.agentPierNotificationCopy = {
  kinds: {
    permission: {
      title: "AgentPier: Freigabe erforderlich",
      body: "Eine Session wartet auf deine Entscheidung.",
      name: "Freigabe erforderlich",
    },
    question: {
      title: "AgentPier: Rückfrage",
      body: "Eine Session wartet auf deine Antwort.",
      name: "Rückfrage",
    },
    "session-completed": {
      title: "AgentPier: Antwort bereit",
      body: "Öffne AgentPier, um den aktuellen Stand anzusehen.",
      name: "Antwort bereit",
    },
    "session-waiting": {
      title: "AgentPier: Session wartet",
      body: "Eine Session wartet im Terminal auf dich.",
      name: "Wartet im Terminal",
    },
    "session-ended": {
      title: "AgentPier: Session beendet",
      body: "Öffne AgentPier, um den Status anzusehen.",
      name: "Session beendet",
    },
    "pipeline-gate": {
      title: "AgentPier: Pipeline wartet",
      body: "Eine Pipeline wartet auf deine Entscheidung.",
      name: "Pipeline wartet",
    },
    "pipeline-completed": {
      title: "AgentPier: Pipeline abgeschlossen",
      body: "Öffne AgentPier, um das Ergebnis anzusehen.",
      name: "Pipeline abgeschlossen",
    },
    "pipeline-failed": {
      title: "AgentPier: Pipeline fehlgeschlagen",
      body: "Öffne AgentPier, um zu sehen, was fehlschlug.",
      name: "Pipeline fehlgeschlagen",
    },
    "agent-approval": {
      title: "AgentPier: Freigabe erforderlich",
      body: "Ein Agent wartet auf deine Entscheidung.",
      name: "Freigabe erforderlich",
    },
    "agent-checkin": {
      title: "AgentPier: Agent meldet sich",
      body: "Ein Agent hat etwas für dich. Öffne den Chat des Agenten.",
      name: "Meldet sich",
    },
    "agent-routine": {
      title: "AgentPier: Routine- oder Hook-Ergebnis",
      body: "Eine Routine, Erinnerung oder ein Hook hat in den Chat eines Agenten geschrieben.",
      name: "Routine- oder Hook-Ergebnis",
    },
    "telegram-revocation": {
      title: "AgentPier: Telegram-Zugang noch aktiv",
      body: "Ein entfernter Bot oder eine entfernte Person ließ sich nicht stoppen. Starte den Agentendienst neu.",
      name: "Telegram-Zugang noch aktiv",
    },
    "github-token": {
      title: "AgentPier: GitHub-Token prüfen",
      body: "Ein gespeicherter GitHub-Token ist ungültig, abgelaufen oder läuft bald ab.",
      name: "GitHub-Token prüfen",
    },
    "disk-space": {
      title: "AgentPier: Speicherplatz wird knapp",
      body: "Auf dem Laufwerk mit den AgentPier-Daten sind weniger als 10 % frei.",
      name: "Speicherplatz wird knapp",
    },
    test: {
      title: "AgentPier: Testbenachrichtigung",
      body: "Benachrichtigungen erreichen dieses Gerät.",
      name: "Testbenachrichtigung",
    },
  },
  // Was ein Agent freigeben lassen will.
  subjects: {
    exec: "Shell-Befehl",
    ssh: "SSH-Befehl",
    coding: "Coding-Auftrag",
    memory: "Gedächtniseintrag",
    grant: "Berechtigung für ein Mitglied",
    hook: "Hook-Vorschlag",
    team: "Team-Vorschlag",
  },
  tools: {
    claude: "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
  },
  quote: (text) => `„${text}“`,
};
