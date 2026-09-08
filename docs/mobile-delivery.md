# Nachrichten auf dem Handy senden und wiederherstellen

Der Chat speichert Entwürfe und bereits hochgeladene Anhänge im Browser. Beim
Wiederöffnen derselben Sitzung stehen sie wieder bereit. Ein anderer Account oder
eine andere Sitzung erhält einen getrennten Entwurf. Browserdaten sind an die
Adresse gebunden: localhost und die mobile HTTPS-Adresse teilen keinen Speicher.

Nach dem Senden erscheint die Nachricht sofort im Verlauf. Ihr Status zeigt:

- **Wartet auf Übergabe:** lokal gespeichert, noch nicht bestätigt angenommen.
- **Wird übergeben / Übergabe läuft:** ein Übergabeversuch ist aktiv.
- **An Sitzung übergeben:** die Terminal-Eingabe ist beendet. Das bestätigt noch
  keinen Bearbeitungsbeginn und auch keine interne Warteschlange des Providers.
- **Nicht übergeben:** die Sitzung oder eine Freigabe hat die Eingabe vor dem
  Schreiben abgelehnt. Über „Nachricht bearbeiten“ wird sie wieder zum Entwurf.
- **Zustellung unklar:** die Eingabe könnte bereits erfolgt sein. Zuerst Verlauf
  oder Terminal prüfen. Nur bewusst als Entwurf übernehmen; erneutes Senden kann
  ansonsten dieselbe Arbeit noch einmal auslösen.

Beim Aufwachen oder Neuladen fragt der Chat den vorhandenen Zustellungsbeleg ab.
Er sendet dabei keine neue Eingabe. Wenn kein Beleg vorhanden ist, lässt sich die
Übergabe ausdrücklich erneut versuchen. Dieser Versuch verwendet dieselbe ID;
der Server führt einen bereits bekannten Auftrag nicht nochmals aus.

Die vorläufige Chatblase wird durch einen passenden neuen Eintrag aus dem
CLI-Verlauf ersetzt. Falls das CLI den Text verändert, bleibt die Übergabeanzeige
unter Umständen separat sichtbar und kann geschlossen werden. Dieser Textabgleich
ist ausschließlich eine Darstellungshilfe und entscheidet nicht über Wiederholung.

## Speicherung und Grenzen

Fertige Uploads werden als Dateiname und Pfad wiederhergestellt. Lokale Vorschaudaten
werden nicht dauerhaft gespeichert; nach Neuladen bleibt der Dateiname sichtbar.
Ein unterbrochener, noch nicht bestätigter Upload muss erneut ausgewählt werden.
Gelöschte Dateien werden dadurch nicht wiederhergestellt.

Web Locks verhindert, dass zwei Tabs ihre ausstehenden Aufträge gegenseitig
überschreiben. Aktuelle Browser mit Web Locks und nutzbarem lokalem Speicher sind
für den geschützten Versand erforderlich. Speicherprobleme erscheinen als Fehler;
ohne gespeicherten Auftrag startet der Chat keinen neuen Übergabeversuch.

Browserdaten löschen entfernt auch Entwürfe und lokale Übergabeanzeigen. Der
Server behält private Belege ohne Nachrichtentext bis zum Löschen der Sitzung.
Die Garantie setzt wie bisher eine einzelne AgentPier-Instanz pro Datenverzeichnis
voraus. Ein erfolgreicher Beleg ist keine Bestätigung des KI-Providers.

![Mobile Zustellungsanzeige mit unklarer Übergabe](screenshots/agentpier-mobile-delivery.png)
