// Ticketfolgen im Tickets-Tab eines Projekts: die Warteschlange mit ihren Zuständen,
// die Gründe, aus denen ein Ticket auf dich wartet (je ein Eintrag aus PARK_REASONS),
// und deine Aktionen.
export const ticketQueueCopy = {
  title: "Warteschlange",
  states: {
    waiting: "Wartet",
    running: "Läuft",
    "awaiting-merge": "Wartet auf Merge",
    "needs-owner": "Braucht dich",
    done: "Erledigt",
  },
  reasons: {
    githubRequired: "Das Projekt hat keinen GitHub-Zugang.",
    sourceUnavailable: "Die Ticketquelle ist nicht mehr verbunden.",
    ticketUnavailable: "Das Ticket wurde nicht gefunden.",
    startFailed: "Das Ticket konnte nicht gestartet werden.",
    startInterrupted: "AgentPier wurde neu gestartet, während dieses Ticket startete.",
    taskNotDelivered: "Die Aufgabe hat die Session nicht erreicht.",
    sessionEnded: "Die Session endete ohne Pull Request.",
    runFailed: "Der Pipeline-Lauf ist fehlgeschlagen.",
    noPullRequest: "Die Arbeit endete ohne Pull Request.",
    prClosed: "Der Pull Request wurde ohne Merge geschlossen.",
    mergeDisarmed: "Auto-Merge oder die Merge-Queue wurde auf GitHub abgeschaltet.",
    armRefused: "GitHub hat Auto-Merge oder die Merge-Queue abgelehnt.",
    mergeRefused: "GitHub hat den Merge abgelehnt.",
    idle: "Der Pull Request blieb 30 Minuten lang rot.",
    failedRounds: "Die Checks sind dreimal fehlgeschlagen.",
    forgeUnreachable: "GitHub war 30 Minuten lang nicht erreichbar.",
    repairUnconfigured:
      "Für die Reparatur-Session fehlen Einstellungen einer Coding-Session.",
    repairFailed: "Die Reparatur-Session konnte nicht starten.",
    other: "AgentPier braucht deine Entscheidung.",
  },
  pullRequest: (number) => `Pull Request #${number}`,
  rowActions: (key) => `Aktionen in der Warteschlange für ${key}`,
  retry: "Erneut versuchen",
  markDone: "Als erledigt markieren",
  remove: "Aus der Warteschlange entfernen",
  openSession: "Session öffnen",
  openRun: "Lauf öffnen",
  openPullRequest: "Pull Request öffnen",
  doneTitle: (key) => `${key} als erledigt markieren?`,
  doneBody:
    "Die Folge geht zum nächsten Ticket weiter. In GitHub oder Plane wird nichts am Ticket geändert.",
  removeTitle: (key) => `${key} aus der Warteschlange entfernen?`,
  removeBody:
    "Das Ticket verlässt die Folge. Seine Session, sein Pull Request und der Eintrag im Tracker bleiben.",
};

// Tickets in der Liste auswählen und der Dialog, der sie als Folge startet.
export const ticketSequenceStartCopy = {
  select: "Tickets auswählen",
  selectTicket: (key) => `${key} auswählen`,
  startSelected: (count) => `Als Folge starten (${count})`,
  deselected: (keys) => `Nicht mehr in der Liste und daher abgewählt: ${keys}.`,
  title: (count) =>
    count === 1 ? "1 Ticket als Folge starten" : `${count} Tickets als Folge starten`,
  order: (keys) =>
    `AgentPier bearbeitet sie nacheinander in dieser Reihenfolge: ${keys}.`,
  runAs: "Starten als",
  session: "Session",
  pipeline: "Pipeline-Lauf",
  pipelineLabel: "Pipeline",
  searchPipelines: "Pipelines durchsuchen",
  choosePipeline: "Pipeline wählen",
  noPipelines: "Es gibt noch keine Pipelines.",
  repair: "Reparatur-Session",
  repairHint: "Startet, wenn Checks fehlschlagen oder Änderungen angefordert werden.",
  repairDefaults: "Vorbelegt mit der neuesten Coding-Session in diesem Projekt.",
  allowMerge: "Merge erlauben",
  allowMergeHint:
    "AgentPier merged jeden Pull Request per Auto-Merge oder Merge-Queue oder selbst, sobald die Pflicht-Checks grün sind. Nie an fehlschlagenden Checks oder angeforderten Änderungen vorbei.",
  start: "Folge starten",
};
