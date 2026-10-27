// Archive, restore and permanent delete of any agent (agent-lifecycle.js on the server).
export const agentLifecycleCopy = {
  archive: "Archivieren",
  restore: "Wiederherstellen",
  deletePermanently: "Endgültig löschen",
  deleteHint: "Chats, Gedächtnis und Arbeitsbereich werden endgültig gelöscht",
  membersTitle: (name, count) =>
    count === 1
      ? `${name} und sein temporäres Mitglied archivieren?`
      : `${name} und seine ${count} temporären Mitglieder archivieren?`,
  membersBody:
    "Seine temporären Team-Mitglieder werden mit ihm archiviert. Dauerhafte Mitglieder bleiben. Du kannst sie später wiederherstellen.",
  deleteTitle: (name) => `${name} endgültig löschen?`,
  deleteBody:
    "Das lässt sich nicht rückgängig machen. Ältere Backups enthalten den Agenten weiter, und das Aktivitätsprotokoll behält seine Einträge.",
  counting: "Zähle, was gelöscht wird …",
  lost: "Damit gelöscht:",
  chats: (count) => (count === 1 ? "1 Chat" : `${count} Chats`),
  routines: (count) =>
    count === 1
      ? "1 Routine, Erinnerung oder Hook"
      : `${count} Routinen, Erinnerungen und Hooks`,
  memoryFiles: (count) =>
    count === 1
      ? "1 Notiz oder Gedächtnisdatei"
      : `${count} Notizen und Gedächtnisdateien`,
  workspaceFiles: (count) =>
    count === 1 ? "1 Datei im Arbeitsbereich" : `${count} Dateien im Arbeitsbereich`,
  members: (count) =>
    count === 1 ? "1 temporäres Team-Mitglied" : `${count} temporäre Team-Mitglieder`,
  kept: "Projektgedächtnis sowie Coding- und Pipeline-Läufe, die er gestartet hat, bleiben.",
  typeName: (name) => `Gib „${name}“ zur Bestätigung ein`,
  deletionPending: "Löschen ausstehend",
  deletionFailed: (code) =>
    `Löschen ausstehend · letzter Versuch fehlgeschlagen: ${code}`,
};
