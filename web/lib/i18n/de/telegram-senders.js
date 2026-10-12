export const telegramSendersCopy = {
  title: "Telegram für andere Personen",
  description:
    "Gib diesem Agenten einen eigenen Telegram-Bot, damit Personen deiner Wahl ihm schreiben können. Jede Person führt eine eigene Unterhaltung mit dem Agenten. Dein eigener AgentPier-Bot bleibt davon getrennt.",
  boundary:
    "Personen auf dieser Liste sprechen direkt mit dem Agenten. Er kann für sie sein Gedächtnis, Webwerkzeuge und MCP-Server nutzen, aber nie Shell, AgentPiers eigene Werkzeuge oder Chat-Befehle.",
  shellBlocked:
    "Dieser Agent hat Shell-Zugriff. Schalte die Shell aus, bevor du einen Bot für andere Personen verbindest.",
  token: "Bot-Token",
  tokenHint:
    "Lege mit BotFather einen eigenen Bot für diesen Agenten an. Verwende nie deinen AgentPier-Bot oder den Bot eines anderen Agenten.",
  replaceToken: "Neuer Bot-Token",
  connect: "Bot verbinden",
  saveToken: "Token ersetzen",
  disconnect: "Bot trennen",
  bot: (username) => `Bot @${username}`,
  people: "Erlaubte Personen",
  peopleHint:
    "Nur diese Telegram-Konten können dem Bot schreiben. Frage jede Person nach ihrer numerischen Telegram-Nutzer-ID, zum Beispiel über @userinfobot. Benutzernamen funktionieren nicht.",
  noPeople: "Noch kann niemand dem Bot schreiben. Füge mindestens eine Person hinzu.",
  personId: "Telegram-Nutzer-ID",
  personName: "Name",
  addPerson: "Person hinzufügen",
  remove: "Entfernen",
  removePerson: (name) => `${name} entfernen`,
  invalidId: "Gib eine numerische Telegram-Nutzer-ID ein.",
  duplicate: "Diese Person steht bereits auf der Liste.",
  voiceOn:
    "Sprachnachrichten werden mit dem Deepgram-Schlüssel aus deinen Kontoeinstellungen transkribiert.",
  voiceOff:
    "Sprachnachrichten werden nicht transkribiert. Hinterlege einen Deepgram-Schlüssel in deinen Kontoeinstellungen, um sie einzuschalten.",
  pending:
    "Gespeicherte Änderungen sind noch nicht aktiv. Starte den Agentendienst neu, um sie zu übernehmen.",
  apply: "Jetzt übernehmen",
  status: (state) => `Status: ${state}`,
  states: {
    running: "läuft",
    starting: "startet",
    error: "Fehler, prüfe den Bot-Token",
    stopped: "Agentendienst gestoppt",
    pending: "wartet auf einen Neustart",
    inactive: "inaktiv",
  },
};
