# Vollständiger Datei-Explorer für AgentPier

- Datum: 2026-09-13
- Status: Fachlicher Entwurf im Gespräch bestätigt; schriftliche Spezifikation zur Prüfung.
- Basis: `356f1d0` (AgentPier 1.17.0).
- Arbeitszweig: `chore/file-explorer-design`.

## 1. Ziel und bestätigte Entscheidungen

AgentPier erhält unter **Verwaltung → Dateien** einen vollständigen Datei-Explorer,
der ohne laufende Sitzung nutzbar ist. Er zeigt das Dateisystem des Rechners, auf dem
AgentPier läuft, und verwendet die Rechte des Betriebssystem-Benutzers des
AgentPier-Prozesses. Das gilt auch beim Zugriff von einem Handy oder anderen Rechner.

Der Nutzer hat folgende Entscheidungen bestätigt:

- Freie Navigation, soweit die Benutzerrechte reichen; keine Beschränkung auf
  registrierte Projekte oder vorab freigegebene Ordner in der Verwaltung.
- Ein gemeinsames Explorer-Modul für Verwaltung und Sitzungen.
- Erstellen, Umbenennen, Kopieren, Verschieben, Löschen, Upload und Download,
  Mehrfachauswahl, Suche, Vorschau und ZIP-Funktionen.
- Ein Editor mit Tabs, Syntaxhervorhebung, Suchen/Ersetzen und Strg/Cmd+S genügt.
- Zwischenzeitliche Änderungen durch Agenten oder andere Programme müssen beim
  Speichern als Konflikt behandelt werden.
- Löschen verwendet standardmäßig einen AgentPier-Papierkorb mit Wiederherstellung.
  Endgültiges Löschen und Leeren sind gesonderte, bestätigte Aktionen.
- Desktop und Handy sowie deutsche und englische Bedienung gehören zum Umfang.

Die folgenden Abschnitte präzisieren diese Entscheidungen. Die genannten
Standardgrenzen und Fehlerabläufe sind konkrete Vorschläge für die Umsetzung.

## 2. Ausgangslage und gewählter Ansatz

`web/features/files/FileExplorer.jsx` bietet derzeit eine sitzungsgebundene Liste,
Text- und Bildvorschau sowie Ordnererstellung. Navigation liegt in der URL.
`server/features/files/project-files.js` begrenzt Zugriffe auf das Sitzungsprojekt,
prüft auf ausbrechende Pfade und zeigt höchstens 100 Einträge pro Seite.
Die aktuelle Vorschau ist auf 256 KiB Text beziehungsweise 5 MiB Bilddaten begrenzt.

`server/http/routes/files.js` stellt drei sitzungsgebundene Endpunkte bereit.
Die globale Ordnerauswahl unter `/api/directories` kann bereits absolute Ordnerpfade
auflösen. Chat- und Terminal-Uploads haben eigene, sitzungsgebundene Speicherorte;
sie bilden keine allgemeine Dateiübertragung in einen gewählten Zielordner ab.

| Ansatz                              | Vorteil                                                | Aufwand / Nachteil                                                 | Entscheidung |
| ----------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ | ------------ |
| Gemeinsames Explorer-Modul          | Einheitliche Bedienung und gemeinsame Dateiregeln      | Bestehende Komponenten erhalten explizite Zugriffskontexte         | Gewählt      |
| Eigenständiger Verwaltungs-Explorer | Bestehende Sitzungsansicht bleibt technisch unabhängig | Doppelte Bedienlogik, Tests und spätere Weiterentwicklung          | Verworfen    |
| Eingebetteter fertiger Dateimanager | Viele Standardfunktionen verfügbar                     | Zusätzliche Integration von Anmeldung, Übersetzung und Darstellung | Verworfen    |

Die bestehende Sitzungsansicht behält ihren Projektzugriffsbereich. Der neue
Verwaltungszugang erhält den globalen Zugriff. Die gemeinsame Oberfläche allein
darf den Zugriffskontext nicht erweitern; der Server bestimmt ihn bei jeder Anfrage.
Ein Link aus der Sitzung kann den Verwaltungs-Explorer am Projektpfad öffnen.

## 3. Navigation, Darstellung und Suche

Die Verwaltungsseite ist unter `/files` erreichbar. Beim ersten Öffnen startet sie
im Home-Verzeichnis. Pfadleiste, anklickbare Pfadsegmente, übergeordneter Ordner und
Vor-/Zurücknavigation ermöglichen auch den direkten Sprung zu absoluten Pfaden.
`~` wird auf das Home-Verzeichnis des AgentPier-Prozesses aufgelöst.

Ordnerbaum und Dateiliste laden ihre Inhalte bei Bedarf. Die Liste zeigt Name,
Dateityp, Größe und Änderungszeit; Ordner stehen beim Sortieren zuerst. Ein
Eigenschaftenbereich zeigt zusätzlich Pfad, Verknüpfungsziel und Dateirechte.
Größen ganzer Ordner werden nur auf ausdrückliche Anfrage berechnet.

Favoriten und registrierte Projektordner dienen als Schnellzugriffe. Favoriten
werden hostbezogen in den privaten AgentPier-Einstellungen gespeichert. Fehlerhafte
oder nicht mehr erreichbare Favoriten bleiben entfernbar. Die Anzeige versteckter
Einträge lässt sich umschalten; eingeschaltet umfasst sie auch `.git`.

Dateinamensuche arbeitet im aktuellen Ordner und optional rekursiv darunter.
Sie unterstützt Teilzeichenfolgen und eine Option für Groß-/Kleinschreibung.
Ergebnisse zeigen relative Pfade und lassen sich im enthaltenden Ordner öffnen.
Rekursive Suche ist abbrechbar, folgt keinen Verzeichnisverknüpfungen und meldet
ausgelassene, nicht lesbare Bereiche sowie erreichte Grenzen ausdrücklich.

Der URL-Zustand enthält Zugriffskontext, aktuellen Ordner, aktive Datei, Sortierung,
Filter und Seitenauswahl. Inhalte, Entwürfe und Bearbeitungstoken gehören nicht in
URLs. Browser-Zurück und das Neuladen funktionieren für die globale Seite und
bestehende Sitzungslinks. Eine ungültige Seite wird als solche angezeigt.

Auf dem Desktop lassen sich Navigation, Liste und Vorschau/Editor nebeneinander
verwenden. Auf kleinen Bildschirmen wechseln diese Bereiche in eine einzelne
Hauptansicht; Ordnerbaum und Aktionen sind über erreichbare Bedienelemente zugänglich.
Jede Kontextmenüaktion besitzt auch einen sichtbaren Menü- oder Schaltflächenzugang.

## 4. Dateioperationen und Konfliktregeln

Dateien und Ordner lassen sich erstellen, umbenennen, kopieren, ausschneiden,
einfügen, verschieben und löschen. Mehrfachauswahl unterstützt Tastatur, Maus und
Touch. Interne Drag-and-drop-Verschiebungen zeigen das Ziel vor dem Ausführen an;
externe Dateien im Drop-Bereich starten den Upload-Ablauf.

Die interne Zwischenablage enthält Dateireferenzen und die Aktion, keine
Dateiinhalte. Sie ist innerhalb des geöffneten Explorers nutzbar und wird vor der
Ausführung auf noch vorhandene Quellen und gültige Rechte geprüft. Nach einem
fehlgeschlagenen Verschieben bleibt die nicht verschobene Auswahl verfügbar.

| Situation                                         | Verhalten                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------ |
| Zielname existiert                                | Ersetzen, Überspringen, Beide behalten oder Vorgang abbrechen                  |
| Mehrere Konflikte                                 | Entscheidung pro Eintrag; optional auf weitere gleichartige Konflikte anwenden |
| Beide behalten                                    | Server reserviert einen freien Namen, etwa `Bericht (2).txt`                   |
| Bestehender Zielordner                            | Explizites Zusammenführen; Konflikte seiner Kinder einzeln behandeln           |
| Datei und Ordner am gleichen Zielnamen            | Keine automatische Typumwandlung; umbenennen oder überspringen                 |
| Quelle entspricht Ziel                            | Verständlicher Fehler; keine Änderung                                          |
| Ordner soll in eigenen Unterordner                | Vor Ausführung ablehnen, auch über Verknüpfungen                               |
| Quelle oder Ziel ändern sich nach einer Rückfrage | Entscheidung erneut prüfen; keine veraltete Überschreibfreigabe verwenden      |
| Einige Einträge scheitern                         | Erfolgreiche und fehlgeschlagene Einträge getrennt anzeigen                    |

Beim Ersetzen wird die bestehende Zieldatei zunächst wiederherstellbar gesichert.
Erst eine vollständig geschriebene Ersatzdatei darf am Ziel sichtbar werden.
Ein Fehler darf weder eine vorhandene Datei abschneiden noch durch erneuten Klick
unbemerkt einen zweiten Schreibvorgang auslösen. Operationen besitzen dafür eine
Idempotenzkennung; dieselbe Kennung mit verändertem Auftrag wird abgewiesen.

Verschieben innerhalb eines Dateisystems nutzt die geeignete Umbenennungsoperation.
Über Dateisystemgrenzen wird erst kopiert und geprüft, dann die unveränderte Quelle
entfernt. Bei Fehler, Abbruch oder erkennbarer Quelländerung bleiben die Quellen
aller noch nicht erfolgreich abgeschlossenen Einträge erhalten. Bereits vollständig
verschobene Einträge und fertiggestellte Kopien werden im Ergebnis ausgewiesen.
Ein ganzer Mehrfachvorgang ist keine atomare Transaktion und verspricht keinen
automatischen vollständigen Rollback.

Neu erstellte Dateien erhalten `0600`, neue Ordner `0700`, jeweils unter
Berücksichtigung der Prozess-Umask. Beim Bearbeiten bleiben Modus, Besitzer, Gruppe,
ACLs und erweiterte Attribute vorhandener Dateien erhalten. Kann der gewählte
Schreibweg dies nicht leisten, wird Speichern abgewiesen und „Speichern unter“
angeboten. Atomisches Ersetzen benötigt auch passende Rechte im Elternverzeichnis;
es fällt nicht auf ein abschneidendes Schreiben in die Originaldatei zurück.

Kopieren erhält Modus, Änderungszeit, ACLs und erweiterte Attribute, soweit das
Zieldateisystem sie unterstützt, und meldet Abweichungen. Ein Verschieben über
Dateisystemgrenzen sowie die Aufnahme in den Papierkorb müssen zusätzlich Besitzer
und Gruppe für die Wiederherstellung erhalten. Falls das nicht möglich ist,
bleibt die betroffene Quelle erhalten. Eine Rechte- oder Besitzerverwaltung über
`chmod`, `chown`, ACL-Editoren oder Rechteerhöhung ist nicht Teil dieses Entwurfs.

## 5. Upload, Download und ZIP

Uploads unterstützen Dateiauswahl, Mehrfachauswahl, Drag-and-drop und die Auswahl
eines Ordners. Relative Unterordner werden rekonstruiert. Leere Ordner werden
übernommen, wenn die Browserauswahl sie liefert; liefert eine Browser-API nur
Dateien mit relativen Pfaden, wird diese Einschränkung im Upload-Dialog erklärt.
Die mobile Dateiauswahl bietet die vom jeweiligen Browser unterstützten Varianten.

Die Übertragungsansicht zeigt pro Datei Ziel, Fortschritt und Ergebnis sowie
Abbrechen und Wiederholen. Große Inhalte werden als Byte-Stream mit Backpressure
übertragen. Sie durchlaufen weder Base64 noch einen allgemeinen JSON-Body-Parser.
Unvollständige Uploads liegen unter privaten temporären Namen und erscheinen erst
nach erfolgreichem Abschluss unter ihrem endgültigen Dateinamen.

Wiederholen überträgt eine fehlgeschlagene Datei vollständig neu. Bereits
abgeschlossene Einträge bleiben abgeschlossen. Nach einem Seitenreload muss der
Nutzer lokale Quelldateien bei Bedarf erneut auswählen; der Browser verspricht
keinen dauerhaften Zugriff auf diese Dateien. Bytegenaue Fortsetzung unterbrochener
Uploads gehört nicht zum ersten vollständigen Funktionsumfang.

Einzeldateien werden direkt gestreamt heruntergeladen. Ordner und Mehrfachauswahl
werden als ZIP angeboten. Die Downloadantwort setzt einen bereinigten Dateinamen,
`Content-Disposition: attachment`, `nosniff` und `no-store`. Für direkte Downloads
zeigt der Browser Fortschritt und Abbruch; der Explorer behauptet keinen Nachweis,
dass die Datei auf dem Client vollständig gespeichert wurde.

ZIP-Erstellung in einen Zielordner und ZIP-Entpacken sind zusätzlich eigene
Dateioperationen. Große Arbeiten laufen als Jobs. Ein ZIP-Download aus mehreren
Quellen erhält eine eindeutige Archivstruktur; identische oberste Namen werden
vor Beginn aufgelöst. Archive mit fehlenden Quellen werden als Fehler gemeldet,
statt still ein scheinbar vollständiges Ergebnis auszuliefern.

Beim Entpacken gelten Pfad-, Namens- und Konfliktregeln auch für jeden Archiveintrag.
Absolute Pfade, ausbrechende `..`-Segmente, Verknüpfungseinträge, Sonderdateien und
verschlüsselte Archive werden abgewiesen. Tatsächlich entpackte Bytes, Eintragszahl
und Tiefe werden während der Verarbeitung begrenzt. Erstellen und Herunterladen
von ZIPs folgen keinen Verknüpfungen; ausgelassene Links werden vor dem Start
angezeigt und müssen als Auslassung bestätigt werden.

Das Entpacken erfolgt zunächst in einem privaten Arbeitsbereich. Erst nach
Validierung werden Einträge nach den Konfliktregeln veröffentlicht. Es gibt keine
Shell-Interpolation von Dateinamen. Benötigte Bibliotheken werden als reguläre,
gesperrte Paketabhängigkeiten ausgeliefert. Falls ein nativer Helfer nötig wird,
muss er über Neuinstallation und Update bereitgestellt werden.

## 6. Vorschau und Editor

Der Editor wird als eigener, verzögert geladener Baustein mit CodeMirror 6 geplant.
Die Trennung von Editorzustand, Darstellung und Suchfunktionen passt zu den
geforderten Tabs und Suchen/Ersetzen. Diese Module sind in den offiziellen
[State-](https://github.com/codemirror/state),
[View-](https://github.com/codemirror/view) und
[Search-Repositories](https://github.com/codemirror/search) dokumentiert.
Die Paketquellen sind laut deren README auf die verlinkte Maintainer-Forge umgezogen;
Paketversionen und Integration werden im technischen Umsetzungsplan festgelegt.

Tabs behalten Inhalt, Cursor, Scrollposition und Undo-Verlauf beim Dateiwechsel.
Ungespeicherte Tabs sind markiert. Strg/Cmd+S speichert den aktiven Tab; Speichern,
Schließen und Suchen/Ersetzen sind auch über Schaltflächen erreichbar. Globale
Explorer-Tastenkürzel dürfen Texteingabe und Editor-Zwischenablage nicht übernehmen.
Schließen eines geänderten Tabs oder Verlassen der Ansicht fragt nach Speichern,
Verwerfen oder Abbrechen. Entwürfe bleiben im Arbeitsspeicher; sie werden nicht
automatisch in Browserdatenbanken, Logs oder auf dem Server abgelegt.

Bearbeitung unterstützt UTF-8 einschließlich erkanntem BOM. Einheitliche LF- oder
CRLF-Zeilenenden und das Vorhandensein eines abschließenden Zeilenumbruchs bleiben
erhalten. Gemischte Zeilenenden werden vor Bearbeitung angezeigt; eine notwendige
Normalisierung erfordert eine bewusste Auswahl. Andere Kodierungen und Binärdateien
bleiben herunterladbar, werden aber nicht versehentlich als Text gespeichert.

Syntaxhervorhebung umfasst zunächst JavaScript/JSX, TypeScript/TSX, JSON, HTML, CSS,
Markdown, Python, Shell, YAML und TOML; unbekannte Textformate nutzen Klartext.
Ein vollständiger IDE-Ausbau mit Sprachservern, Debugger und Erweiterungsmarktplatz
gehört nicht zum Umfang.

Vorschau unterstützt Text sowie PNG, JPEG, GIF und WebP. HTML und SVG werden als
Quelltext angezeigt und niemals als aktive Anwendung ausgeführt. Große oder nicht
unterstützte Dateien erhalten eine verständliche Downloadoption. PDF-, Office-,
Audio- und Videovorschau sowie gerendertes HTML sind keine Abnahmekriterien.

### Speichern bei parallelen Änderungen

Beim Öffnen liefert der Server Inhalt, Dateimetadaten und eine undurchsichtige
Revision, abgeleitet aus Dateiidentität und Inhaltsfingerabdruck. Speichern sendet
die erwartete Revision. AgentPier serialisiert eigene konkurrierende Schreibvorgänge
pro Ziel und prüft die aktuelle Revision unmittelbar vor der Veröffentlichung.

Bei Abweichung bleibt der Entwurf erhalten. Die Oberfläche zeigt eigenen Entwurf
und aktuellen Plattenstand zum Vergleichen. Der Nutzer kann den aktuellen Stand
übernehmen, manuell abgleichen oder den Entwurf unter einem neuen Namen speichern.
Ein bewusstes Ersetzen benötigt die neu gelesene Revision; weitere Änderungen
erzeugen wieder einen Konflikt. Gelöschte oder verschobene Dateien werden nicht
stillschweigend neu angelegt.

Saubere Tabs werden bei erkannter externer Änderung als veraltet markiert und können
neu geladen werden. Geänderte Tabs werden nie automatisch ersetzt. Aktualisierung
erfolgt nach eigenen Operationen sowie beim Fokuswechsel und über begrenzte Abfragen
der gerade sichtbaren Ansicht; es gibt keinen rekursiven Watcher für das gesamte
Dateisystem. Die Speicherprüfung gilt unabhängig von diesen Aktualisierungen.

Atomisches Veröffentlichen verhindert teilweise sichtbare Dateien. Eine Revision
ist jedoch kein dateisystemweiter Compare-and-swap gegenüber beliebigen externen
Programmen. Die Umsetzung muss das verbleibende Rennen zwischen Prüfung und
Veröffentlichung offen dokumentieren, den vorgefundenen Inhalt wiederherstellbar
sichern und kontrollierte Konkurrenzfälle testen. Sie darf keine exklusive Sperre
gegenüber nativen Agenten versprechen, die diese Sperre nicht beachten.
Diese Grenze gilt ebenso für Quellprüfungen vor Verschieben und Papierkorbaufnahme;
die getesteten Garantien dürfen nicht mit einer Momentaufnahme eines beliebig
parallel veränderten Dateisystems gleichgesetzt werden.

## 7. AgentPier-Papierkorb

Der Papierkorb wird innerhalb des Explorers angeboten. Einträge zeigen Originalpfad,
Löschzeit, Typ und bekannte Größe. Wiederherstellen bringt sie an den Originalort;
bei fehlendem Elternordner oder Konflikt wird eine bewusste Zielentscheidung verlangt.
Ein Sitzungszugang sieht nur Einträge seines zulässigen Projektbereichs und kann
auch bei der Wiederherstellung seine Projektgrenze nicht überschreiten.

Papierkorbdaten und ein wiederanlaufbares Journal liegen privat unter dem
AgentPier-Datenverzeichnis im eigenen Feature-Bereich. Nutzdaten und Originalpfade
werden nicht in normale Diagnose- oder Audit-Ausgaben übernommen. Papierkorbinhalte
und Transfer-Arbeitsdateien sind aus gewöhnlichen AgentPier-Backups ausgeschlossen;
dieser Ausschluss wird in der Betriebsdokumentation erklärt.

Im gleichen Dateisystem wird ein Eintrag unter einer generierten Kennung in den
Papierkorb verschoben. Über Dateisystemgrenzen werden Inhalt und erforderliche
Metadaten zunächst in einen privaten Zwischenbereich kopiert und überprüft. Die
Quelle wird erst entfernt, wenn eine wiederherstellbare Kopie und ihr Journal
dauerhaft vorliegen und keine Quelländerung festgestellt wurde.

Kann das nicht garantiert werden, schlägt das Verschieben in den Papierkorb mit
erhaltener Quelle fehl. Es gibt keinen automatischen Rückfall auf endgültiges
Löschen. Beim Wiederanlauf wird ein unklarer Zustand als unterbrochen angezeigt;
vorhandene Originale und Sicherungskopien werden nicht auf Verdacht entfernt.

Löschen einer Verknüpfung betrifft die Verknüpfung selbst. Das Ziel wird nicht
rekursiv gelöscht. Dateisystemwurzeln, die Projektwurzel im Sitzungszugang sowie der
aktive Papierkorb und seine übergeordneten Verzeichnisse können nicht als Ganzes
über die Explorer-Löschaktion entfernt werden. Diese Operationsregeln beschränken
nicht die Navigation in lesbare Ordner.

Es gibt keine automatische Ablaufzeit für Papierkorbinhalte. Belegter Speicher
wird angezeigt; voller Speicher führt zu einem Fehler mit erhaltener Quelle.
Endgültiges Löschen und Leeren nennen Auswahl und Tragweite in einem eigenen Dialog.
Endgültiges Löschen bedeutet reguläres Entfernen, kein zugesichertes sicheres
Überschreiben physischer Datenträger. Überschreibsicherungen aus Dateioperationen
werden im selben Papierkorb mit dem Grund „Ersetzt“ sichtbar.

## 8. Zugriff und Verknüpfungen

Alle Endpunkte verwenden die vorhandene Besitzeranmeldung, Host-/Origin-Prüfung
und Prüfung schreibender Anfragen. MCP- und Sitzungstoken erhalten keine neue globale
Dateiberechtigung. Die Dateifunktion führt keine Rechteerhöhung aus und verwendet
keine anderen Account-Zugangsdaten, um Betriebssystemfehler zu umgehen.

Jede Operation prüft ihre tatsächlichen Quellen und Ziele auf dem Server.
Dateirechte in einer Auflistung sind Hinweise; verbindlich ist das Ergebnis der
Dateisystemoperation. Lesbare, aber nicht schreibbare Dateien bleiben lesbar.
Fehlende Rechte erscheinen als verständlicher Fehler am betroffenen Eintrag.

Im globalen Kontext dürfen Verzeichnisverknüpfungen ausdrücklich geöffnet werden,
wenn das Betriebssystem den Zugriff erlaubt. Im Sitzungskontext muss das aufgelöste
Ziel innerhalb der serverseitig bestimmten Projektwurzel bleiben. Verschieben,
Umbenennen und Löschen behandeln den ausgewählten Link als Eintrag. Rekursives
Kopieren erhält Links als Links und folgt ihnen nicht. Textbearbeitung über einen
Link bindet sich an die angezeigte aufgelöste Zieldatei und erkennt Zielwechsel als
Konflikt. Defekte Links sind als solche sichtbar und als Links verwaltbar.

Reguläre Dateiübertragungen und Vorschauen akzeptieren keine Geräte, FIFOs oder
Sockets. Rekursive Arbeiten melden solche ausgelassenen Einträge. Hardlinks werden
erkannt; eine atomare Textbearbeitung darf deren Semantik nicht still verändern.
Solche Dateien sind zunächst nur lesbar und können als neue, unabhängige Datei
gespeichert werden.

Auflistungen und Dateinamensuche lesen keine Dateiinhalte vorab. Inhalte werden nur
für eine ausdrücklich geöffnete Datei oder beauftragte Dateioperation verarbeitet.
Bestehende Account- und Credential-APIs behalten ihre Geheimnisfilter. Explorer-
Metadaten, Jobs, Fehler, Logs und Telemetrie enthalten keine Tokens, Passwörter oder
Dateiinhalte; Dateinamen werden niemals als HTML oder Shell-Code interpretiert.
Gezielter Besitzerzugriff auf eine Datei ist von automatischer Metadatenanreicherung
zu unterscheiden. Native Prozesse unter demselben OS-Benutzer sind weiterhin keine
gegeneinander abgeschotteten Betriebssystem-Konten.

## 9. Technische Grenzen und Komponenten

| Baustein                          | Verantwortung und Abhängigkeiten                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Zugriffskontext und Pfadauflösung | Global-/Projektbereich aus vertrauenswürdigen Serverdaten; Pfade, Linksemantik und Revisionen prüfen |
| Dateidienst                       | Auflisten, Eigenschaften, Lesen, Erstellen und einzelne Mutationen; verwendet Zugriffskontext        |
| Jobdienst                         | Warteschlange, Fortschritt, Idempotenz, Abbruch, Konfliktentscheidungen und Wiederanlauf             |
| Transfer- und Archivdienst        | Byte-Streams, temporäre Dateien, ZIP-Prüfungen; nutzt Dateidienst und Jobdienst                      |
| Papierkorbdienst                  | Private Nutzdaten, Journal, Wiederherstellen und endgültiges Entfernen                               |
| Explorer-Oberfläche               | Navigation, Auswahl, Dateiaktionen, Status und gemeinsame Desktop-/Mobilbedienung                    |
| Editor-Baustein                   | Tabs, Bearbeitungszustand, Sprachmodule und Konfliktvergleich; schreibt über den Dateidienst         |

Frontend-Code bleibt unter `web/features/files/`, Backend-Code unter
`server/features/files/`. HTTP-Adapter unter `server/http/routes/` bleiben schmal.
Neue globale Endpunkte liegen unter `/api/files`; bisherige Sitzungsendpunkte
bleiben als kompatible Adapter des Projektkontexts bestehen. Die Umstellung erhält
bestehende URLs und die bisherigen Antwortformen für Auflistung und Vorschau.
Erweiterte Verträge werden zusätzlich und explizit eingeführt.

`web/app/routes.js`, `web/app/Sidebar.jsx`, die Seiteneinbindung und
`server/http/security.js` erhalten die Route `/files` einschließlich zulässiger
HTML-Navigation. Datei- und Editor-Module werden erst beim Öffnen geladen.
Neue Texte verwenden reaktive Nachrichtenexporte und stabile Kennungen mit
passenden Argumenten in Deutsch und Englisch, auch für Job- und Serverfehler.

Upload- und Textinhalt-Endpunkte erhalten gezielte Transportbehandlung vor dem
allgemeinen 64-KiB-JSON-Parser in `server/app.js`. Metadaten behalten enge Grenzen;
größere Nutzdaten rechtfertigen keine globale Erhöhung aller Request-Limits.

Lange Arbeiten laufen nicht ausschließlich innerhalb der Lebensdauer eines
HTTP-Handlers. Private persistierte Jobmetadaten erlauben Statusabfragen nach einem
Seitenwechsel oder Serverneustart. Der Jobdienst veröffentlicht Änderungen in kurzen
kritischen Abschnitten unter der bestehenden Mutationsbarriere; Dateiübertragung
und langes Warten auf Browserdaten halten keine globale Snapshot-Sperre fest.
Feature-eigene Pfadsperren verhindern Konflikte zwischen eigenen Jobs. Sie
berücksichtigen auch sich überlappende Eltern- und Kindpfade und verwenden eine
einheitliche Sperrreihenfolge für Operationen mit mehreren Quellen und Zielen.

Jobzustände sind `queued`, `running`, `waiting_for_conflict`, `cancelling`,
`completed`, `partially_completed`, `failed`, `cancelled` und `interrupted`.
Einzelne Dateiergebnisse besitzen stabile Kennungen. Abbruch stoppt weitere Arbeit,
räumt eindeutig zuordenbare unvollständige temporäre Dateien auf und erhält fertige
Ergebnisse. Nach Prozessabbruch werden laufende Jobs abgeglichen und bei nicht
beweisbarem Abschluss als `interrupted` angezeigt. Destruktive Schritte werden
nicht allein wegen eines Neustarts automatisch wiederholt.

Ein abgebrochener Browser-Upload beendet den betreffenden Empfang. Bereits
serverseitig laufende Kopier-, Archiv- und Papierkorbarbeiten laufen bei bloßem
Seitenwechsel weiter; ein expliziter Abbruch erfolgt über ihre Jobkennung.
Verwaltungszugang kann globale Jobs sehen; Sitzungskontext erhält ausschließlich
passende Projektjobs. Papierkorb und Jobs erhalten keine automatische MCP-Freigabe.

## 10. Anfangsgrenzen und Betrieb

Die Grenzwerte sind getrennte, zentral definierte Größen. Der Server teilt der
Oberfläche die wirksamen Werte mit, damit sie verständliche Hinweise geben kann.
Administratoren können Transfer- und Arbeitsgrenzen über dokumentierte
Hostkonfiguration ändern; Werte werden beim Start validiert.

| Bereich                              | Ausgangswert / Verhalten                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Dateiliste                           | 200 Einträge pro Seite; höchstens 100.000 Einträge pro Verzeichnis-Snapshot; Überschreitung ausdrücklich melden  |
| Rekursive Dateinamensuche            | Höchstens 100.000 untersuchte Einträge, 10.000 Treffer oder 30 Sekunden; Ergebnis als unvollständig kennzeichnen |
| Textbearbeitung                      | 2 MiB pro Datei; größere Dateien bleiben herunterladbar                                                          |
| Bildvorschau                         | 20 MiB pro Datei; keine unbeschränkte serverseitige Dekodierung                                                  |
| Einzelner Upload                     | 10 GiB; tatsächliche Bytes während Empfang zählen                                                                |
| Upload-, Kopier- oder Archivjob      | 50 GiB verarbeitete Nutzdaten, 50.000 Einträge, 128 Verzeichnisebenen; vor Überschreitung kontrolliert stoppen   |
| Gleichzeitige Dateiübertragungen     | 3 pro Besitzer; weitere warten in der Warteschlange                                                              |
| Terminale Jobmetadaten               | Nach 7 Tagen entfernbar; Journal ungelöster Vorgänge und Papierkorbeinträge bleibt erhalten                      |
| Unvollständige Upload-Arbeitsdateien | Nach 24 Stunden ohne aktiven Job entfernen; nur eindeutig als temporär registrierte Dateien                      |
| Papierkorb                           | Keine automatische Löschung; verfügbarer Speicher begrenzt die Aufnahme                                          |

Metadaten großer Verzeichnisse, Suchergebnisse und Joblisten werden begrenzt und
seitenweise ausgeliefert. Obergrenzen werden nie als vollständiges Ergebnis
verschwiegen. Sparse-Dateien dürfen keine unbegrenzte Materialisierung auslösen;
Bytebudgets berücksichtigen die tatsächlich zu kopierenden bzw. entpackten Daten.

Der Explorer benötigt keine zusätzliche laufende Anwendung. Das Node-/React-
Paket bleibt der Installationsweg. Zusätzliche Laufzeithelfer müssen bei Installation
und Updates für macOS und Linux verfügbar sein; manuelle Maschinenkorrekturen sind
kein akzeptierter Bestandteil der Auslieferung.

## 11. Lieferabschnitte und Abnahme

Dies sind zusammengehörige Lieferabschnitte des bestätigten Gesamtumfangs, noch
kein kleinteiliger Implementierungsplan. Ein Abschnitt darf den gemeinsamen
Zugriffsvertrag nicht umgehen, um eine Funktion früher bereitzustellen.

| Abschnitt                          | Sichtbares Ergebnis                                                                                         | Abnahmeschwerpunkt                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1. Grundlage und Navigation        | Verwaltungseintrag, freie Navigation, gemeinsame Sitzungsansicht, Favoriten, Liste, Eigenschaften und Suche | Globale OS-Rechte, unveränderte Projektgrenze, Links, direkte URLs, große Verzeichnisse              |
| 2. Mutationen und Papierkorb       | Erstellen, Umbenennen, Kopieren/Verschieben, Mehrfachauswahl, Konflikte, Wiederherstellen                   | Keine abgeschnittenen Zieldateien, Ersetzen mit Sicherung, Abbruch, Dateisystemwechsel, Wiederanlauf |
| 3. Transfers und Archive           | Uploads, Downloads, Ordner, Fortschritt, ZIP-Erstellen und Entpacken                                        | Streaming, Bytegrenzen, Unterbrechung, Namenskollisionen und Archive mit schädlichen Pfaden          |
| 4. Vorschau und Editor             | Bildvorschau, Editor-Tabs, Sprachen, Suchen/Ersetzen, Speichern und Konfliktvergleich                       | UTF-8/BOM/Zeilenenden, ungespeicherte Entwürfe, Agentenänderungen, Links und Schreibrechte           |
| 5. Gesamtabnahme und Dokumentation | Durchgängige Desktop-/Mobilbedienung, Übersetzungen, Betriebsdokumentation                                  | macOS/Linux, Chromium/WebKit, Englisch, Tastatur/Touch und bestehende Dateiansicht                   |

Für die Backend-Abnahme werden ausschließlich isolierte temporäre Homes,
Projektverzeichnisse und Datenverzeichnisse verwendet. Kein Test greift auf echte
Nutzersitzungen oder den Standard-tmux-Server zu. Fehler werden kontrolliert
eingespeist: fehlende Rechte, Platzmangel, Verbindungsabbruch, Serverneustart,
geänderte Revision, Symlink-Zielwechsel und wiederholte Aufträge.

Integration und Blackbox-Tests prüfen jeden neuen Endpunkt einschließlich
Besitzeranmeldung, Origin-Schutz und Ablehnung von Machine-Tokens. Eigenschaftstests
decken Pfadauflösung, Namenskollisionen und Archivmitglieder ab. Browserprüfungen
decken kritische Aufgaben auf Desktop und Mobil, in Deutsch und ausdrücklich auch
Englisch, in Chromium und WebKit ab. Systemrechte und Dateisystemwechsel werden
zusätzlich auf macOS und Linux validiert; simulierte Fehler allein sind kein
Nachweis der Plattformkompatibilität.

Abgeschlossen ist die Funktion erst nach `npm run check`, den betroffenen
Browser-Suiten, Katalog-Paritätsprüfungen und der vorgeschriebenen CI-/Review-Abnahme.
UI-Änderungen werden im PR durch Screenshots belegt. Langfristige Bedienungs- und
Betriebsregeln gehen nach `docs/`; abgeschlossene temporäre Spezifikationen und
Pläne unter `docs/superpowers/` werden vor dem abschließenden PR beziehungsweise
vor dem Merge entfernt. Solange die Umsetzung offen ist, bleibt diese Spezifikation
als aktives Arbeitsdokument erhalten.

## 12. Bewusste Grenzen

Der Explorer verwaltet das Dateisystem des AgentPier-Hosts einschließlich bereits
vom Betriebssystem eingebundener Laufwerke. Ein eigener SSH-/SFTP-Dateimanager,
Cloud-Laufwerke, Volltextindex, Dateiversionshistorie, allgemeine Synchronisation,
automatisches Speichern und Echtzeit-Zusammenarbeit im Editor sind separate Features.
Sie werden nicht benötigt, um den hier bestätigten Datei-Explorer abzunehmen.

Vor der Umsetzung sind keine weiteren fachlichen Grundsatzentscheidungen offen.
Die Prüfung dieser schriftlichen Fassung soll insbesondere sicherstellen, dass die
präzisierten Betriebsgrenzen und Wiederherstellungsabläufe dem beabsichtigten
Verhalten entsprechen. Danach kann ein konkreter Umsetzungsplan mit Dateien,
Schnittstellen, Testfällen und Abhängigkeiten erstellt werden.
