// The owner's Settings › Users: restricted users, their agents and levels.
export const usersCopy = {
  intro:
    "Weitere Personen, die mit Agenten chatten. Sie sehen keine Sessions, Pipelines oder Systemeinstellungen.",
  add: "Benutzer anlegen",
  addTitle: "Benutzer anlegen",
  displayName: "Anzeigename",
  username: "Benutzername",
  firstPassword: "Erstes Passwort",
  passwordHint: "Mindestens 12 Zeichen. Gib es der Person auf sicherem Weg.",
  create: "Anlegen",
  empty: "Noch keine Benutzer. Lege den ersten an.",
  disabled: "Deaktiviert",
  needsPassword: "Braucht ein neues Passwort",
  loading: "Benutzer werden geladen …",
  allUsers: "Alle Benutzer",
  notFound: "Diesen Benutzer gibt es nicht mehr.",
  account: "Konto",
  resetPassword: "Passwort zurücksetzen",
  resetTitle: (name) => `Passwort für ${name} zurücksetzen`,
  newPassword: "Neues Passwort",
  resetHint: "Mindestens 12 Zeichen. Alle Geräte der Person werden abgemeldet.",
  reset: "Zurücksetzen",
  passwordReset: "Passwort zurückgesetzt. Alle Geräte der Person sind abgemeldet.",
  active: "Anmelden erlaubt",
  activeSub:
    "Aus: Die Person ist abgemeldet, ihre Erinnerungen, Routinen und Telegram-Bots werden endgültig entfernt.",
  ownerMayRead: "Besitzer darf Chats lesen",
  ownerMayReadSub:
    "Die Person sieht das in ihrer App. Es gilt ab jetzt, nie für ältere Chats.",
  ownerMayReadSince: (date) => `An seit ${date}`,
  agents: "Agenten",
  agentsHint:
    "Für Agenten von Benutzern immer gesperrt: Shell, SSH, Git/GitHub, Geheimnisse, Coding und Teams. Projektordner und MCP-Server gibst du pro Agent frei.",
  noAgents: "Noch keine Agenten für diese Person.",
  own: "Eigener Agent",
  shared: "Geteilter Agent",
  levelFor: (name) => `Stufe für ${name}`,
  levels: { chat: "Nur chatten", personalize: "Personalisieren", extended: "Erweitert" },
  openAgent: (name) => `Einstellungen von ${name}`,
  addAgent: "Agent für diese Person anlegen",
  joinShared: "Zu einem geteilten Agenten hinzufügen",
  joinTitle: "Geteilten Agenten wählen",
  joinLabel: "Geteilter Agent",
  join: "Hinzufügen",
  noShared: "Keine weiteren geteilten Agenten.",
  delete: "Benutzer löschen",
  deleteTitle: (name) => `${name} löschen?`,
  deleteBody:
    "Die Person kann sich nicht mehr anmelden. Ihre privaten Chats werden gelöscht, außer du darfst sie lesen.",
  deleteConfirm: "Jetzt löschen",
  ownAgentsChoice: "Ihre eigenen Agenten",
  archiveAgents: "Archivieren",
  keepAgents: "Unter meinem Konto behalten",
  keepAgentsReveals:
    "Behaltene Agenten werden deine, mit ihrem Gedächtnis, ihren Dateien und dem angemeldeten Browser.",
  keepAgentsNeedsOptIn:
    "Ihre eigenen Agenten werden archiviert. Behalten kannst du sie nur, solange du ihre Chats lesen darfst, denn ihr Gedächtnis, ihre Dateien und ihr Browser sind privat.",
  agentsOfUsers: "Agenten von Benutzern",
  openMyChat: "Meinen Chat öffnen",
  forUser: "Für",
  forMe: "Für mich",
  agentKind: "Art",
  locked:
    "Für Agenten von Benutzern gesperrt: Sie können keine Programme auf diesem Rechner ausführen.",
  lockedList: (list) => `Gesperrt: ${list}.`,
  ownPrivate:
    "Privat für seinen Benutzer: Notizen und Browser erscheinen hier nur, solange „Besitzer darf Chats lesen“ für diese Person an ist (Einstellungen › Benutzer).",
  ownReadOnly:
    "Gehört seinem Benutzer: Du kannst Notizen lesen und den Browser ansehen, aber nichts ändern.",
  ownRoutines: "Erinnerungen und Routinen verwaltet sein Benutzer in seiner App.",
  ownRoutinesChatOnly:
    "Erinnerungen und Routinen verwaltet sein Benutzer in seiner App ab „Personalisieren“. Bei „Nur chatten“ kann er sie noch ansehen, pausieren und löschen.",
  ownTelegramBelowExtended:
    "Seinen Telegram-Bot kann sein Benutzer in seiner App verbinden, sobald du ihm „Erweitert“ gibst. Du kannst diesem Agenten keinen Bot verbinden.",
  ownTelegram:
    "Seinen Telegram-Bot verbindet sein Benutzer in seiner App. Du kannst diesem Agenten keinen Bot verbinden.",
  lockedTelegramSenders:
    "Für Agenten von Benutzern gesperrt: ein eigener Telegram-Bot für andere Personen.",
  lockedNames: {
    shell: "Shell",
    ssh: "SSH",
    github: "Git/GitHub",
    pipelines: "Pipelines",
    coding: "Coding",
    teams: "Teams",
    sessions: "Zugriff auf seine anderen Chats (Session-Tools)",
    secrets: "Geheimnisse",
    visibleBrowser: "Sichtbares Browserfenster",
  },
  access: "Benutzer dieses Agenten",
  accessHint:
    "Ein geteilter Agent teilt Gedächtnis, Profil (USER.md) und Browser mit allen, die ihn nutzen. Ihre Chats bleiben privat.",
  released: "Freigegebene Fähigkeiten",
  releasedHint:
    "Benutzer mit der Stufe Erweitert dürfen diese Fähigkeiten selbst umschalten.",
  remove: (name) => `${name} entfernen`,
  unknownUser: "Unbekannter Benutzer",
};
