export const assistantChannelCopy = {
  language: "Sprache der Telegram-Hinweise",
  languageDe: "Deutsch",
  languageEn: "Englisch",
  languageHint:
    "Hinweise von AgentPier (Freigaben, Team-Updates, Links) verwenden diese Sprache. Sie wird beim ersten Verbinden aus diesem Browser übernommen; erneutes Koppeln behält Ihre Wahl. Bereits eingereihte Hinweise behalten ihren Text; die Antworten des Agenten werden nicht übersetzt.",
  appUrl: "AgentPier-Adresse für Links",
  appUrlHint:
    "Telegram-Hinweise verlinken auf diese Adresse. Sie wird beim Verbinden oder Koppeln aus diesem Browser übernommen; leer lassen, um Hinweise ohne Links zu senden.",
  saveAppUrl: "Adresse speichern",
  ignored: (privateCount, groupCount) =>
    `Ignorierte Nachrichten: ${privateCount} aus anderen privaten Chats, ${groupCount} aus Gruppen.`,
  teamNotification: "Team-Benachrichtigung",
  connected: (chatId) => `Mit privatem Chat ${chatId} verbunden`,
  description:
    "Nutze den gemeinsamen Chat dieses Agenten aus deinem privaten Telegram-Chat. Antworten auf Telegram-Nachrichten kommen in Telegram an.",
  paused: "Pausiert oder wartet auf Kopplung",
  disconnected: "Getrennt",
  failed: "Die Kanal-Aktion konnte nicht abgeschlossen werden.",
  token: "Telegram-Bot-Token",
  botHint:
    "Erstelle mit BotFather einen eigenen Bot. Wird er bereits von einem anderen Dienst genutzt, trenne ihn dort zuerst.",
  connect: "Telegram verbinden",
  pairHint:
    "Öffne den Link und sende die Startnachricht, um deinen privaten Chat zu koppeln. Der Code gilt zehn Minuten.",
  pair: "Meinen privaten Chat koppeln",
  newPair: "Neuen Kopplungscode erstellen",
  pause: "Telegram pausieren",
  resume: "Telegram fortsetzen",
  disconnect: "Bot trennen",
  speechLink: "Deepgram unter Konten verwalten",
  activity: "Telegram-Aktivität",
  voice: "Sprachnachricht",
  retry: "Erneut versuchen",
  review: "Ohne erneuten Versand bestätigen",
  openChat: "Agenten-Chat prüfen",
  title: "Telegram",
  inProgress:
    "Noch in Bearbeitung. Hier erscheint eine Prüfaktion, sobald deine Entscheidung nötig ist.",
  states: {
    partial: "Teilweise erfolgreich",
    queued: "In der Warteschlange",
    voice_pending: "Wartet auf Transkription",
    transcribing: "Wird transkribiert",
    transcription_failed: "Transkription fehlgeschlagen",
    dispatching: "Agent wird gestartet",
    running: "Agent arbeitet",
    model_uncertain: "Ausgang der Anfrage unklar",
    model_reviewed: "Ausgang im Chat geprüft",
    outbound: "Wartet auf Versand",
    delivering: "Antwort wird gesendet",
    delivered: "Zugestellt",
    delivery_failed: "Zustellung fehlgeschlagen",
    delivery_uncertain: "Ausgang der Zustellung unklar",
    reply_unavailable: "Antwort ohne Text",
    failed: "Fehlgeschlagen",
    cancelled: "Abgebrochen",
    reviewed: "Zur Kenntnis genommen",
  },
  diagnostics: {
    CHANNEL_DESTINATION_CHANGED:
      "Die Chat-Verknüpfung hat sich geändert. Prüfe diesen Eingang, bevor es weitergeht.",
    TELEGRAM_CONFLICT:
      "Ein anderer Dienst ruft diesen Bot ab. Stoppe ihn vor dem Fortsetzen.",
    TELEGRAM_WEBHOOK:
      "Für diesen Bot ist bereits ein Webhook eingerichtet. Trenne zuerst die andere Integration.",
    TELEGRAM_UNAVAILABLE: "Telegram ist gerade nicht erreichbar.",
    TELEGRAM_REJECTED:
      "Telegram hat die Anfrage abgewiesen. Prüfe die Bot-Verbindung und ob der Chat Nachrichten zulässt.",
    TELEGRAM_RATE_LIMIT:
      "Telegram verlangt eine Pause. Der Versand wird nach der Wartezeit fortgesetzt.",
    MEDIA_TOO_LARGE: "Sprachnachrichten sind auf 10 MB und zehn Minuten begrenzt.",
    MEDIA_UNSUPPORTED: "Unterstützt werden Text und Ogg-Sprachnachrichten.",
    VOICE_TOO_LONG:
      "Die Sprachnachricht war zu lang und wurde vor dem Herunterladen abgelehnt.",
    TRANSCRIPTION_REJECTED:
      "Deepgram hat die Audiodatei abgelehnt. Die Antwort von Deepgram steht darunter.",
    TRANSCRIPTION_QUOTA:
      "Das Deepgram-Guthaben oder Kontingent ist erschöpft. Prüfe dein Deepgram-Konto.",
    TRANSCRIPTION_RATE_LIMITED:
      "Deepgram hat nach mehreren Versuchen weiterhin eine Pause verlangt. Du kannst die Transkription später erneut versuchen.",
    MEDIA_DOWNLOAD: "Die Sprachnachricht konnte nicht heruntergeladen werden.",
    SPEECH_NOT_CONFIGURED: "Richte vor der Transkription Deepgram unter Konten ein.",
    SPEECH_AUTH: "Deepgram hat den Schlüssel abgewiesen. Aktualisiere ihn unter Konten.",
    TRANSCRIPTION_EMPTY: "Es wurde keine Sprache erkannt.",
    TRANSCRIPTION_FAILED:
      "Transkription fehlgeschlagen. Du kannst sie gezielt erneut versuchen.",
    TRANSCRIPTION_INTERRUPTED:
      "Die Transkription wurde unterbrochen und nicht automatisch wiederholt.",
    MODEL_REQUEST_FAILED:
      "Die Agenten-Anfrage ist fehlgeschlagen oder wurde abgebrochen.",
    MODEL_OUTCOME_UNKNOWN:
      "Prüfe und kläre zuerst die ungewisse Anfrage im Agenten-Chat.",
    REPLY_UNAVAILABLE: "Warte auf die bestätigte Antwort zu dieser Anfrage.",
    REPLY_TOO_LARGE:
      "Die Antwort überschreitet das Versandlimit dieser Telegram-Anbindung.",
    REPLY_WITHOUT_TEXT:
      "Der Agent hat ohne Textantwort geendet. Prüfe sie im Agenten-Chat; an Telegram wurde nichts gesendet.",
    CHANNEL_QUEUE_FULL:
      "Die Telegram-Warteschlange ist voll. Neue Nachrichten werden abgelehnt, bis wartende Eingänge verarbeitet oder geprüft sind.",
    DECISION_FAILED:
      "Eine Entscheidung aus Telegram konnte nicht gespeichert werden. Entscheide stattdessen in AgentPier.",
    MODEL_OUTCOME_REVIEWED:
      "Die ungewisse Anfrage wurde im Agenten-Chat geprüft. An Telegram wurde nichts gesendet.",
    CALLBACK_FAILED:
      "Ein Telegram-Button konnte nicht verarbeitet werden. Entscheide stattdessen in AgentPier.",
    TEAM_NOTIFICATION_FAILED:
      "Telegram-Benachrichtigungen für ein Team konnten nicht vorbereitet werden. Prüfe das Team in AgentPier.",
    DELIVERY_UNCERTAIN:
      "Telegram könnte die Antwort erhalten haben. Prüfe vor der Bestätigung deinen Chat; es wird nichts automatisch erneut gesendet.",
  },
};
