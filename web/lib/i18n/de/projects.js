export const projectsHubCopy = {
  topline: "WORKSPACE / PROJEKTE",
  subtle: "Lokal gespeichert",
  title: "Projekte",
  description:
    "Vom Repository zur nächsten Sitzung. Wissen, AgentBus und Läufe je Projekt.",
  addFolder: "Ordner hinzufügen",
  listLabel: "Projekte",
  loading: "Projekte werden geladen …",
  partialError:
    "Nicht alle Projektquellen konnten geladen werden. Die übrigen Projekte bleiben verfügbar.",
  localOnly: "Nur lokal",
  decisions: (count) =>
    count === 1 ? "1 Entscheidung erforderlich" : `${count} Entscheidungen erforderlich`,
  failedRuns: (count) =>
    count === 1 ? "1 Lauf fehlgeschlagen" : `${count} Läufe fehlgeschlagen`,
  tokenMeta: (name) => `Token ${name}`,
  back: "Alle Projekte",
  tabsLabel: "Projektbereiche",
  tabOverview: "Übersicht",
  tabKnowledge: "Projektwissen",
  tabAgentBus: "AgentBus",
  tabRuns: "Läufe",
  notFound: "Projekt nicht gefunden",
  notFoundDescription:
    "Dieses Projekt ist nicht mehr vorhanden. Wähle ein anderes Projekt aus der Liste.",
  runsUnavailable:
    "Läufe gehören zu einem Projektordner. Füge den Ordner hinzu, um Pipelines darin zu starten.",
};
export const projectOverviewCopy = {
  factsLabel: "Projektdetails",
  remote: "Remote",
  branch: "Branch",
  tokenProfile: "Token-Profil",
  folder: "Ordner",
  noToken: "Keins",
  sessions: (count) => `Sitzungen · ${count}`,
  noSessions: "Noch keine Sitzungen in diesem Projekt.",
  open: "Öffnen",
  openSession: (name) => `Sitzung ${name} öffnen`,
  justNow: "gerade eben",
};
export const projectDialogsCopy = {
  noToken: "Ohne Token",
  cloneContinues: "Das Klonen läuft weiter, wenn du diesen Dialog schließt.",
  addFolderDescription:
    "Ein vorhandener Ordner wird als Projekt für Wissen, AgentBus und Läufe registriert.",
  mergeOlder: "Älteren Eintrag zusammenführen",
  mergeOlderDescription: (name, date) =>
    `Zu diesem Ordner gehört ein älterer Projekteintrag „${name}“ vom ${date}. Beim Zusammenführen geht alles, was er enthält, in dieses Projekt über.`,
  mergeMoves: "Was übernommen wird",
  mergeLoading: "Umfang wird ermittelt …",
  mergeEntries: (count) => `Memory-Einträge: ${count}`,
  mergeCapabilities: (count) => `Memory-Zugänge von Sitzungen: ${count}`,
  mergeSsh: (count) => `SSH-Schlüssel und -Hosts: ${count}`,
  mergeArtifacts: (count) => `Artefakte: ${count}`,
  mergeVerification: (count) => `Prüfschritte: ${count}`,
  mergeSessions: (count) => `Sitzungen: ${count}`,
  mergeWarning:
    "SSH-Zugänge und die Berechtigungen von Sitzungen, die den älteren Eintrag genutzt haben, gehen auf den aktuellen Ordner über. Das lässt sich nicht rückgängig machen.",
  mergeConfirm: "Zusammenführen",
};
