---
name: agentpier-composer
description: Begleitet ein Thema, Epic oder mehrere Plane-Tickets von der Klärung über Arbeitsaufträge und AgentPier-Pipelines bis zu geprüften Pull Requests. Verwenden, wenn Arbeit in Plane geplant und mit AgentPier koordiniert umgesetzt werden soll; reine Codeänderungen brauchen diesen Skill nicht.
---

# AgentPier Composer

Plane hält die fachlichen Aufträge, AgentPier führt sie aus. Zerlege nur so weit,
wie unabhängige Umsetzung und Prüfung davon profitieren. Nutze den bestehenden
Auftrag und bereits erteilte Freigaben; Planung allein startet keine Umsetzung.

## 1. Kontext und Auftrag

- Lies die lokalen Repository-Regeln und prüfe Checkout, Remote und Basisbranch.
  Übernimm vorhandene Themenstände, bevor du neue Tickets oder Läufe anlegst.
- Ermittle das Plane-Projekt aus dem Auftrag oder bestehenden Tickets. Ist es
  nicht eindeutig, kläre es vor dem Schreiben. Löse Kennungen mit
  `workitem retrieve_by_identifier` auf; API-Aufrufe verwenden die gelieferten
  Projekt- und Work-Item-UUIDs.
- Prüfe verfügbare Plane-Werkzeuge sowie den Zugriff auf die vorgesehene
  AgentPier-Instanz. Lies bei lokalem Quellcode `docs/pipelines.md` und bei Bedarf
  die Pipeline-Routen. Erfinde keine MCP-Werkzeuge oder Runner-Kompatibilität.
- Lies bei verfügbarem AgentBus vor paralleler Arbeit und vor Abschluss
  `inbox_read`; ermittle relevante Sitzungen mit `peers_list`. Sende Aufträge
  über `peer_send` nur bei autorisierter Zusammenarbeit. AgentBus startet keine
  Sitzungen; Peers verschiedener Worktree-Verzeichnisse sind nicht automatisch
  erreichbar. Eine zugestellte Nachricht ist noch keine Auftragsannahme.

## 2. Plane-Aufträge vorbereiten

Prüfe die betroffenen Codestellen und schneide daraus umsetzbare Tickets.
Entscheide gemeinsame Schnittstellen und Datenmodelle einmal für das Thema.
Klärungsbedarf blockiert nur die betroffenen Tickets; Routineentscheidungen
triffst du selbst und hältst sie im Auftrag fest.

Jeder Auftrag enthält knapp:

- Ziel und Abgrenzung;
- überprüfbare Akzeptanzkriterien;
- bindende Entscheidungen und relevante Codepfade;
- Abhängigkeiten und erwartete Validierung.

Schreibe im autorisierten Umfang in Plane. Ohne Schreibauftrag bereite die
konkreten Texte vor und kläre nur die noch fehlende Freigabe. Nutze vorhandene
Tickets und ergänze sie, ohne fremde Inhalte zu überschreiben. Ein Epic ist ein
Work Item mit dem über `workitem_type resolve` ermittelten Typ `Epic`; Kinder
verweisen mit `parent` auf seine UUID. Lege ein Epic nur an, wenn es gebraucht wird.
Für Abhängigkeiten erst `workitem_relation list_definitions` lesen und dann die
passende Richtung setzen. Status-UUIDs aus den Projektzuständen auflösen.

Der Auftrag gehört in die Beschreibung oder einen eindeutig zugeordneten
Kommentar. `description_stripped` nimmt Klartext, `comment_html` HTML entgegen.
Lies Änderungen zurück und speichere die IDs. Plane-Status nie nur behaupten.
Ist Plane nicht erreichbar, sichere Entwürfe lokal; ein bereits autorisierter,
vollständiger Auftrag kann trotzdem ausgeführt und später nachgetragen werden.

## 3. In AgentPier ausführen

Nutze eine vorgegebene Pipeline. Fehlt sie, prüfe vorhandene Definitionen und
wähle eine zum Auftrag passende innerhalb der erteilten Ausführungsbefugnis.
Kläre nur materielle offene Entscheidungen, etwa zusätzliche kostenpflichtige
Arbeit oder Veröffentlichung. Ändere dafür nicht stillschweigend Profile.

AgentPiers HTTP-Schnittstelle bietet `GET /api/pipelines`,
`POST /api/pipeline-runs` und `GET /api/pipeline-runs/:id`.
Prüfe Instanzadresse, legitimen Zugriff und den installierten Vertrag vor Nutzung.
Der Start verwendet `{ pipelineId, cwd, task, baseBranch }`: `cwd` ist der absolute
Repository-Pfad, `task` enthält den vollständigen Auftrag samt Plane-Kennung,
bindenden Entscheidungen und Validierung. Plane-Inhalte werden nicht automatisch
geladen. Die lokale Implementierung begrenzt `task` auf 65.536 UTF-8-Bytes;
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

Verlinke den PR am Plane-Ticket und aktualisiere dessen Zustand gemäß dem
Projektworkflow. Standardabschluss ist eine belegte Merge-Empfehlung. Merge nur
bei ausdrücklichem Auftrag, erfüllten Pflichtchecks und geklärten Reviews;
niemals Branch-Schutz umgehen. Melde je Ticket Status, PR, Prüfergebnis und
gegebenenfalls Blocker samt nächstem Schritt.

## Wiederaufnahme

Halte einen kleinen lokalen Themenstand im Git-Metadatenverzeichnis unter
`agentpier-composer/<slug>.json` (`git rev-parse --git-common-dir`). Speichere
Repo/Basisbranch, Plane-Projekt, Entscheidungen und pro Ticket IDs, Abhängigkeiten,
Auftragssnapshot, Run-ID, PR und letzten bekannten Zustand. Keine Zugangsdaten.
Aktualisiere atomar nach relevanten Änderungen; Plane und AgentPier bleiben die
maßgeblichen Quellen. Gleiche beim Fortsetzen Tickets, Läufe und PRs ab, bevor du
etwas erneut anlegst oder startest. Halte ausstehende Plane-Änderungen fest.

Bleibt nur eine menschliche Entscheidung, berichte sie und bewahre den Stand.
Versprich kein Hintergrund-Monitoring ohne verfügbaren Scheduler. Entferne nach
Abschluss und Merge nur saubere, inaktive Worktrees; Pipeline-Worktrees über
AgentPiers Cleanup. Bewahre ungemergte Arbeit und offene Themenstände auf.
