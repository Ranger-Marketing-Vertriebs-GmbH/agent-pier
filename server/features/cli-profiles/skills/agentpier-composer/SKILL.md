---
name: agentpier-composer
description: Begleitet Themen, Epics oder mehrere Tickets von der Klärung über AgentPier-Pipelines und PR-Überwachung bis zum Merge und zur Abarbeitung aller beauftragten Batches. Verwenden, wenn Arbeit anhand von Tickets geplant und mit AgentPier koordiniert umgesetzt werden soll; reine Codeänderungen brauchen diesen Skill nicht.
---

# AgentPier Composer

Das jeweilige Ticketsystem hält die fachlichen Aufträge, AgentPier führt sie aus.
Zerlege nur so weit, wie unabhängige Umsetzung und Prüfung davon profitieren. Nutze den bestehenden
Auftrag und bereits erteilte Freigaben; Planung allein startet keine Umsetzung.

Bei beauftragter Umsetzung umfasst der Loop alle vereinbarten Themen und Batches.
Ein fertiger Lauf, grüner PR oder Statusbericht ist nur ein Zwischenstand: überwache
bis zum bestätigten Merge und starte danach selbstständig den nächsten freigegebenen
Batch. Ein ausdrücklich auf Planung oder PR-Prüfung begrenzter Auftrag bleibt begrenzt.
Die Freigabe für weitere Batches und die Befugnis, selbst zu mergen, sind getrennt;
übernimm bereits erteilte Freigaben, ohne sie an jeder Batch-Grenze erneut anzufordern.

## 1. Kontext und Auftrag

- Lies die lokalen Repository-Regeln und prüfe Checkout, Remote und Basisbranch.
  Übernimm vorhandene Themenstände, bevor du neue Tickets oder Läufe anlegst.
- Ermittle **für jedes Ticket** zuerst das tatsächlich verwendete Ticketsystem
  samt Instanz und Projekt bzw. Repository. Nutze explizite Nutzervorgaben,
  Ticket-URLs, vorhandene Themenstände und Repository-Regeln als Ausgangspunkt.
  GitHub Issues, GitLab Issues, Jira, Linear und Plane sind mögliche Systeme;
  keines davon ist der Standard. Ein Git-Remote oder ein vorhandener Connector
  allein belegt nicht, wo das Ticket geführt wird.
- Prüfe die verfügbaren Integrationen, CLIs oder APIs und lies das referenzierte
  Ticket im passenden System. Bestätige Kennung, Projekt, Titel und Inhalt;
  speichere die kanonische Ticket-URL sowie die vom System gelieferten IDs.
  Kurze Kennungen wie `#42` oder `APP-42` sind ohne ihren Projekt- und
  Instanzkontext nicht eindeutig. Suche gezielt in den durch den Auftrag belegten
  Systemen. Mehrere Treffer oder fehlender Zugriff erlauben keine Zuordnung auf
  Verdacht; kläre nur den fehlenden Link oder System-/Projektkontext.
- Bei verknüpften oder gespiegelten Tickets ermittle das für den Auftrag
  maßgebliche Ticket. Aktualisiere nicht automatisch jede Kopie. Ein Thema kann
  Tickets aus mehreren Systemen enthalten; halte deren Zuordnung getrennt.
  Für neue Tickets übernimm ein belegtes Projektziel oder kläre es vor dem Anlegen.
  Lege vorhandene Tickets nicht in einem anderen System erneut an.
- Prüfe den Zugriff auf die vorgesehene AgentPier-Instanz. Lies bei lokalem
  Quellcode `docs/pipelines.md` und bei Bedarf die Pipeline-Routen. Nutze nur
  tatsächlich verfügbare Werkzeuge und deren Vertrag; erfinde weder
  Ticketsystem-Werkzeuge noch Runner-Kompatibilität.
- Lies bei verfügbarem AgentBus `inbox_read` nur nach einem Nachrichtenhinweis
  oder auf ausdrückliche Nutzeranfrage. Frage nicht periodisch oder vorsorglich
  vor Arbeitsschritten bzw. Abschluss ab; nach einem leeren Ergebnis warte auf
  einen neuen Hinweis. Ermittle relevante Sitzungen mit `peers_list`. Sende Aufträge
  über `peer_send` nur bei autorisierter Zusammenarbeit. AgentBus startet keine
  Sitzungen; Peers verschiedener Worktree-Verzeichnisse sind nicht automatisch
  erreichbar. Eine zugestellte Nachricht ist noch keine Auftragsannahme.

## 2. Aufträge im ermittelten Ticketsystem vorbereiten

Prüfe die betroffenen Codestellen und schneide daraus umsetzbare Tickets.
Entscheide gemeinsame Schnittstellen und Datenmodelle einmal für das Thema.
Klärungsbedarf blockiert nur die betroffenen Tickets; Routineentscheidungen
triffst du selbst und hältst sie im Auftrag fest.

Jeder Auftrag enthält knapp:

- Ziel und Abgrenzung;
- überprüfbare Akzeptanzkriterien;
- bindende Entscheidungen und relevante Codepfade;
- Abhängigkeiten und erwartete Validierung.

Schreibe im autorisierten Umfang in das bestätigte Ticketsystem und Projekt.
Ohne Schreibauftrag bereite die konkreten Texte vor und kläre nur die noch
fehlende Freigabe. Nutze vorhandene Tickets und ergänze sie, ohne fremde Inhalte
zu überschreiben. Prüfe die tatsächlichen Möglichkeiten für Epics, Untertickets,
Abhängigkeiten und Statusübergänge; übertrage keine Plane-Datenfelder auf andere
Systeme. Lege ein Epic nur an, wenn es gebraucht wird. Fehlt eine strukturierte
Beziehung im System, dokumentiere die Abhängigkeit mit eindeutigen Ticket-Links.

Der Auftrag gehört in die Beschreibung oder einen eindeutig zugeordneten
Kommentar, im vom System akzeptierten Textformat. Löse benötigte Typ-, Status-
und Projekt-IDs über dessen vorhandene Werkzeuge auf. Lies Änderungen zurück
und speichere die IDs; Ticket-Status nie nur behaupten.

Nur bei **bestätigtem Plane** gelten diese Besonderheiten: Kennungen
mit `workitem retrieve_by_identifier` auflösen und die gelieferten Projekt- und
Work-Item-UUIDs verwenden. Den Epic-Typ über `workitem_type resolve` ermitteln,
Kinder mit `parent` zuordnen; für Abhängigkeiten zuerst
`workitem_relation list_definitions` lesen. `description_stripped` nimmt Klartext,
`comment_html` HTML entgegen. Prüfe auch diese Werkzeuge vor ihrer Verwendung.

Ist das ermittelte Ticketsystem nicht erreichbar, sichere Entwürfe und
nachzutragende Änderungen lokal mit ihrer Ticket-Zuordnung. Ein bereits
vorliegender, autorisierter und vollständiger Auftrag kann trotzdem ausgeführt
werden; fehlender Zugriff ist kein Anlass, ein anderes System anzunehmen.

## 3. In AgentPier ausführen

Nutze eine vorgegebene Pipeline. Fehlt sie, prüfe vorhandene Definitionen und
wähle eine zum Auftrag passende innerhalb der erteilten Ausführungsbefugnis.
Kläre nur materielle offene Entscheidungen, etwa zusätzliche kostenpflichtige
Arbeit oder Veröffentlichung. Ändere dafür nicht stillschweigend Profile.

AgentPiers HTTP-Schnittstelle bietet `GET /api/pipelines`,
`POST /api/pipeline-runs` und `GET /api/pipeline-runs/:id`.
Prüfe Instanzadresse, legitimen Zugriff und den installierten Vertrag vor Nutzung.
Der Start verwendet `{ pipelineId, cwd, task, baseBranch }`: `cwd` ist der absolute
Repository-Pfad, `task` enthält den vollständigen Auftrag samt Ticketsystem,
Projekt, Ticket-Kennung und URL, bindenden Entscheidungen und Validierung.
Ticket-Inhalte werden nicht automatisch geladen. Die lokale Implementierung
begrenzt `task` auf 65.536 UTF-8-Bytes;
kürze bei Bedarf sinnvoll, ohne Akzeptanzkriterien abzuschneiden.

Starte unabhängige Tickets parallel innerhalb der vereinbarten Kapazität;
ohne Vorgabe beginne mit höchstens zwei Läufen. Plane Überschneidungen bewusst,
serialisiere eng gekoppelte Änderungen. Ein abhängiges Ticket startet erst,
wenn seine Voraussetzungen im tatsächlich verwendeten Basisstand vorhanden sind.
AgentPier erstellt Branch und Worktree selbst. Für manuelle Arbeit gelten die
Repository-Regeln; im AgentPier-Repository liegen Worktrees unter `.worktrees/`.

Fehlt der ausführbare Zugriff, liefere den fertigen `task` und die Startparameter
für die AgentPier-Oberfläche. Behaupte keinen Start und ersetze die Pipeline
nicht ungefragt durch einen anderen Ausführungsdienst.

## 4. Prüfen und abschließen

### Verbindlicher Polling-Loop

Ein erfolgreicher Start beendet den Auftrag nicht. Prüfe jeden gestarteten oder
wiederaufgenommenen Lauf sofort über `GET /api/pipeline-runs/:id` und anschließend
alle **15 Minuten (900 Sekunden)**. Nach Pipeline-Ende übernimmt die PR-Überwachung
denselben Rhythmus bis zum bestätigten Merge. Überwache alle offenen Läufe und PRs,
auch wenn kein Pipeline-Lauf mehr aktiv ist. Ein fertiger oder blockierter Lauf
beendet nicht die Überwachung der anderen. Leite Zustände und angebotene Aktionen aus dem installierten API-Vertrag
ab, nicht aus Terminal-Ausgaben oder vermuteten Statusnamen.

Führe die Schleife in der aktiven Sitzung tatsächlich aus:

1. Lies alle fälligen Lauf- und PR-Zustände, bearbeite Ergebnisse und speichere je Objekt
   `lastCheckedAt`, `nextCheckAt` und den letzten Zustand. Setze die nächste
   Prüfung auf 15 Minuten nach dieser Abfrage; nach dem Start weiterer Läufe
   behalte bereits bestehende Prüftermine bei.
2. Prüfe bei einem beendeten Lauf unmittelbar PR, Akzeptanzkriterien, CI und
   Reviews gemäß dem folgenden Abschnitt. Solange der PR offen ist, kontrolliere
   auch bei grüner CI seinen Merge-Status, aktuellen Head, Reviews und Konflikte
   alle 15 Minuten. Eine Merge-Empfehlung oder aktiviertes Auto-Merge beendet
   diese Überwachung nicht; eine Merge-Queue ist noch kein bestätigter Merge.
3. Verarbeite bestätigte Merges und prüfe danach sofort die gesamte verbleibende
   Themen- und Batch-Liste gemäß „Nach Merge fortsetzen“. Starte ausführbare
   Folgearbeit im selben Turn und nimm ihre Run-IDs in den Loop auf. Leere
   Listen aktiver Läufe und PRs sind kein Abschluss, solange ein freigegebener
   Batch gestartet werden kann.
4. Warte bis zum frühesten offenen Prüftermin mit einem verfügbaren Wartewerkzeug,
   in unterbrechbaren Abschnitten von höchstens 60 Sekunden. Prüfe nach jeder
   Unterbrechung die aktuelle Zeit und neue Nutzervorgaben; eine frühe Rückkehr
   aus dem Wartewerkzeug ersetzt nicht den Prüftermin. Berichte während des
   Wartens knapp den bekannten Stand und den nächsten Prüftermin, ohne einen
   neuen API-Abruf zu behaupten. Fahre danach mit Schritt 1 fort.

Bei vorübergehendem Lesefehler bleibt der Lauf bzw. PR offen; wiederhole die Statusabfrage
beim nächsten Prüftermin. Nach drei aufeinanderfolgenden fehlgeschlagenen Abfragen
oder bei fehlender Zugriffsberechtigung melde den Überwachungsblocker und sichere
den Stand. Ein Lesefehler erlaubt weder einen Neustart noch einen Erfolgsstatus.
Bei `awaiting-human` melde die konkrete Entscheidung sofort und überwache andere
Läufe weiter; menschliche Gates werden nicht automatisch beantwortet.

Statusberichte sind Zwischenmeldungen; führe danach den nächsten Loop-Schritt aus.
Beende den Turn nicht mit „gestartet“, „merge-bereit“ oder „ich prüfe später“, solange
noch überwachbare oder ausführbare Arbeit offen ist. Soll die Sitzung enden und die Überwachung
weiterlaufen, nutze nur einen tatsächlich verfügbaren Scheduler, der die
Composer-Sitzung mit Themenstand, Batch-Liste, Run-IDs und PRs wieder aufrufen kann. Prüfe dessen
erfolgreiche Einrichtung und speichere seine Kennung; vermeide doppelte Monitorjobs
und beende den Job nach Abschluss. Ohne solchen Scheduler bleibt der Loop in der
aktiven Sitzung. Fehlt auch ein nutzbares Wartewerkzeug, benenne diese technische
Grenze ausdrücklich, statt künftige Prüfungen zu versprechen.

### Ergebnisse bearbeiten

Beobachte den echten Laufstatus und berichte Änderungen oder Handlungsbedarf.
`awaiting-human` verlangt die angezeigte Entscheidung; umgehe das Gate nicht.
Terminal-Ruhe ist kein Abschluss. Nutze nur aktuell angebotene Feedback- und
Retry-Aktionen. Sende Feedback über die Pipeline, nicht in ihre aktive Sitzung.
Vermeide doppelte Reparaturschleifen neben dem Pipeline-Budget: nach ausgeschöpftem
Budget oder wiederholt gleichem Fehler Ursache und nächsten Schritt benennen.
Starte nach einem unklaren Request-Ausgang nicht blind einen zweiten Lauf.

Prüfe den tatsächlichen PR-Diff gegen die Akzeptanzkriterien, die erforderlichen
CI-Checks und offene Review-Gespräche. Ein abgeschlossener Lauf garantiert weder
einen PR noch grüne CI. Änderungen können auch nach der PR-Erstellung weiterlaufen;
bewerte den aktuellen Stand. Korrigiere Konflikte erst, wenn kein aktiver Lauf
mehr auf den Branch schreibt, und validiere anschließend erneut.

Verlinke den PR am maßgeblichen Ticket in dessen bestätigtem System und
aktualisiere dessen Zustand gemäß dem Projektworkflow. Bei bestehendem Merge-Auftrag
merge selbstständig, sobald die Pflichtchecks für den aktuellen Head erfüllt,
Reviews geklärt und keine aktiven Branch-Schreiber mehr vorhanden sind; niemals
Branch-Schutz umgehen. Ohne Merge-Befugnis gib die belegte Empfehlung als
Zwischenstand aus und überwache den externen Merge weiter. Fehlende eigene
Merge-Befugnis allein beendet den Loop nicht. Ist eine konkrete menschliche
Entscheidung nötig, melde sie einmal und arbeite an anderen freigegebenen Themen weiter.

### Nach Merge fortsetzen

- Bestätige den Merge über das PR-System und speichere Zielbranch und Merge-Commit.
  Ein geschlossener, aber ungemergter PR ist kein Erfolg: kläre Ablehnung oder
  Ersatz-PR, halte abhängige Tickets zurück und bearbeite unabhängige Arbeit weiter.
- Gleiche den Ticket-Status ab und aktualisiere den vorgesehenen Basisstand sicher
  vom Remote. Prüfe, dass die Voraussetzungen im Basisstand der nächsten Pipeline
  enthalten sind, auch bei Squash-Merges. Überschreibe keine lokalen Änderungen.
- Markiere einen Batch erst als erledigt, wenn alle zugehörigen Tickets geprüft
  und ihre erforderlichen PRs nachweislich gemergt sind. Bei teilweise gemergten
  Batches überwache die übrigen PRs weiter. Beachte vereinbarte Batch-Grenzen,
  Abhängigkeiten und Kapazität; Blocker halten nur davon betroffene Folgearbeit auf.
- Wähle danach den nächsten vollständigen, freigegebenen Batch aus allen noch
  offenen Themen und starte ihn ohne erneute Aufforderung gemäß Abschnitt 3.
  Gleiche unmittelbar vor dem Start vorhandene Läufe ab, damit Wiederaufnahme
  oder ein unklarer Startausgang keine Doppelstarts erzeugen.

Der Gesamtauftrag ist erst abgeschlossen, wenn alle beauftragten Themen und Batches
abgearbeitet, erforderliche PRs gemergt und Ticket-Abgleiche erledigt sind. Berichte
dann das belegte Gesamtergebnis. Ein ausdrücklicher Stopp oder ausschließlich
konkrete Blocker ohne weitere ausführbare oder überwachbare Arbeit erlauben eine
Unterbrechung mit gesichertem Reststand, aber keine Erfolgsmeldung. Reines Warten
auf CI, Review, Merge-Queue oder externen Merge bleibt Teil des Loops.

## Wiederaufnahme

Halte einen kleinen lokalen Themenstand im Git-Metadatenverzeichnis unter
`agentpier-composer/<slug>.json` (`git rev-parse --git-common-dir`). Speichere
Repo/Basisbranch, Auftragsumfang, Ausführungs- und Merge-Freigaben sowie die geordnete
Themen-/Batch-Liste mit Zuordnung, Abhängigkeiten und Fortschritt. Speichere pro Ticket das Ticketsystem, die
Instanz, das Projekt/Repository, die kanonische URL, Kennung und internen IDs,
Abhängigkeiten, Auftragssnapshot, Run-ID, PR, letzten bekannten Zustand und
bestätigten Merge samt Zielbranch und Commit.
Keine Zugangsdaten. Übernimm bei älteren Themenständen eine vorhandene
Plane-Zuordnung nur für die dort belegten Tickets, nicht als Vorgabe für neue.
Halte auch Prüftermine, aufeinanderfolgende Abfragefehler und gegebenenfalls die
Scheduler-Kennung fest. Nach Wiederaufnahme prüfe alle offenen Läufe und PRs sofort,
gleiche bestätigte Merges und die verbleibende Batch-Liste ab und setze den Loop
auch ohne aktive Run-ID fort; ein alter Themenstand belegt keinen aktuellen Status.
Aktualisiere atomar nach relevanten Änderungen; das jeweilige Ticketsystem und
AgentPier bleiben die maßgeblichen Quellen. Gleiche beim Fortsetzen Tickets, Läufe und PRs ab, bevor du
etwas erneut anlegst oder startest. Halte ausstehende Ticket-Änderungen samt
Zielsystem fest.

Bleibt ausschließlich ein konkreter menschlicher Blocker ohne sonstige ausführbare
oder überwachbare Arbeit, berichte ihn und bewahre den Stand.
Versprich kein Hintergrund-Monitoring ohne verfügbaren Scheduler. Entferne nach
Abschluss und Merge nur saubere, inaktive Worktrees; Pipeline-Worktrees über
AgentPiers Cleanup. Bewahre ungemergte Arbeit und offene Themenstände auf.
