export const assistantBrowserCopy = {
  group: "Browser des Agenten",
  visible: "Sichtbarer Browser",
  visibleDescription:
    "Öffnet ein normales Browserfenster statt eines unsichtbaren und schiebt es in die untere rechte Bildschirmecke, aus dem Weg. Viele Shops und Produktseiten blockieren unsichtbare Browser. Zum Anmelden übernimmst du den Browser in seiner Live-Ansicht oder ziehst das Fenster aus der Ecke heraus.",
  noApp:
    "Für sichtbare Fenster braucht der Agent eine eigene Browser-App, nicht deinen Chrome. Installiere sie hier mit „Browser installieren“ oder selbst Brave oder Chromium; danach den Agentendienst neu starten.",
  noDisplay:
    "Auf diesem Rechner gibt es keinen Bildschirm (DISPLAY oder WAYLAND_DISPLAY fehlt). Der Browser läuft deshalb unsichtbar.",
  profile:
    "Der Browser behält seine Anmeldungen und Cookies in einem eigenen Profil dieses Agenten, getrennt von deinen Browserprofilen.",
  running: "Browser läuft",
  runningNow: "Jetzt",
  install: "Browser installieren",
  installDescription:
    "Lädt Chrome for Testing von Google in AgentPiers eigenen Ordner, mit geprüfter Prüfsumme. Kein Homebrew, keine Administratorrechte.",
  restart: "Agentendienst neu starten",
  restartTitle: "Agentendienst neu starten?",
  restartDescription:
    "Ein neu installierter oder entfernter Browser gilt erst nach einem Neustart des Agentendienstes. Laufende Arbeit wird nicht unterbrochen: Ist ein Agent beschäftigt, wird der Neustart abgelehnt.",
  restartConfirm: "Neu starten",
  liveTitle: "Browser",
  liveOpen: "Live-Ansicht öffnen",
  liveOpenDescription:
    "Zeigt das Fenster des Agenten-Browsers live, wo auch immer es auf dem Bildschirm liegt.",
  liveStatus: {
    connecting: "Verbinde …",
    live: "Live",
    stopped: "Der Browser läuft gerade nicht.",
    blocked: "Diese Seite darf nicht angezeigt werden.",
    unavailable: "Die Live-Ansicht ist gerade nicht verfügbar.",
  },
  liveReason: {
    noSlot:
      "Dieses Teammitglied hat noch keinen Browser. Er entsteht, sobald es ihn nutzt.",
    service: "Der Agentendienst ist nicht bereit.",
    noProfile:
      "Für diesen Agenten gibt es kein Browserprofil. Schalte „Einen Browser nutzen“ ein und starte den Agentendienst neu.",
    request: "Der Browser antwortet gerade nicht. Es wird erneut versucht.",
  },
  liveNotConnected:
    "Die Live-Ansicht ist gerade nicht verbunden. Bitte gleich noch einmal versuchen.",
  liveEnded:
    "Die Live-Ansicht wurde beendet. Lade die Seite neu, wenn du angemeldet bist.",
  liveTakeOver: "Übernehmen",
  liveHandBack: "Zurückgeben",
  liveTakeOverHint:
    "Übernimm den Browser, um dich anzumelden oder eine Prüfung zu lösen. Der Agent wartet so lange.",
  liveControlMine: "Du steuerst den Browser. Der Agent wartet, bis du ihn zurückgibst.",
  liveViewOnly:
    "Nur zuschauen: Dies ist der eigene Agent des Benutzers, nur er steuert seinen Browser.",
  liveControlOther: "Du steuerst diesen Browser gerade auf einem anderen Gerät.",
  liveControlWarning:
    "Ohne Eingabe geht der Browser in einer Minute an den Agenten zurück.",
  liveDialogs:
    "Fenster des Browsers selbst (Dateiauswahl, Anmeldedialoge, Berechtigungen, aufgeklappte Auswahllisten) erscheinen hier nicht. Auswahllisten bedienst du mit den Pfeiltasten.",
  liveErrors: {
    LEASE_HELD: "Der Browser wird gerade auf einem anderen Gerät gesteuert.",
    NOT_HOLDER: "Du steuerst den Browser nicht mehr. Übernimm ihn erneut.",
    VIEW_ONLY: "Diese Ansicht kann den Browser nicht steuern.",
    STOP_FAILED: "Der Browser ließ sich nicht beenden. Er läuft weiter.",
  },
  liveTakeOverHere: "Hier übernehmen",
  liveKeyboard: "Tastatureingabe für den Agenten-Browser",
  liveEscape: "Umschalt+Esc führt dich aus dem Browser zurück zu „Zurückgeben“.",
  liveStart: "Browser starten",
  liveStop: "Browser beenden",
  liveStopTitle: "Browser beenden?",
  liveStopBody:
    "Der Agent nutzt den Browser gerade oder jemand steuert ihn. Beenden schließt jetzt seine Tabs; der nächste Browseraufruf des Agenten startet ihn wieder.",
  liveTab: "Tab",
  liveFollow: "Dem Agenten folgen",
  liveNoImage: "Noch kein Bild. Es erscheint, sobald sich die Seite ändert.",
  livePrivacy: "Nur du siehst diese Ansicht. AgentPier speichert keine Bilder.",
  livePreview: (name) => `Live-Ansicht des Browsers von ${name}`,
  reset: "Browserprofil zurücksetzen",
  resetDescription:
    "Beendet den Browser des Agenten und löscht sein Profil mit allen Anmeldungen, Cookies und dem Verlauf.",
  resetConfirm: "Profil zurücksetzen",
  resetTitle: "Browserprofil zurücksetzen?",
  resetDone: "Das Browserprofil wurde gelöscht.",
  resetFailed: "Das Browserprofil konnte nicht zurückgesetzt werden.",
};
