# AgentBus in AgentPier

AgentPier enthält den lokalen AgentBus von David Kaulig unter `vendor/agentbus/`. Grundlage ist das vom Autor bereitgestellte Archiv `agentbus-main.zip` mit SHA-256 `6bae6fc69f886c9260d8b4a03efe21680815e6026c636c2a4121602e1178f69e`. Die MIT-Lizenz bleibt im Vendor-Verzeichnis erhalten. Enthalten sind die benötigten Laufzeitmodule; die separaten Installationsskripte und privaten Marketplace-Einrichtungen des Archivs werden nicht ausgeführt.

## Verhalten

Neue Claude-Code-, Codex- und OpenCode-Arbeitssitzungen verwenden AgentBus standardmäßig. Der Startdialog erlaubt das Abwählen. Login und reine Shell-Sitzungen sind ausgeschlossen. Bereits laufende Sitzungen werden nicht verändert.

Der kanonische Projektpfad bestimmt die Gruppe: Verschiedene CLI-Profile im selben realen Verzeichnis können sich austauschen; andere Projektordner bekommen eine getrennte Registry und Inbox. Daten liegen in `agentbus/projects/<Projekt-Hash>/` im AgentPier-Datenverzeichnis. Es ist kein weiterer Webdienst, Netzwerkport oder global installierter AgentBus erforderlich.

Claude erhält ein temporäres Plugin mit MCP und Lifecycle-Hooks. Codex erhält zusätzliche MCP- und Hook-Startoptionen; vorhandene Hook-Vertrauensentscheidungen bleiben wirksam. Falls Codex neue Hooks zur Prüfung meldet, zeigt AgentPier einen Hinweis auf `/hooks`. OpenCode erhält eine temporäre Plugin-Konfiguration. Die globalen Benutzerkonfigurationen bleiben erhalten.

Die Statusseite zeigt nur zugeordnete AgentPier-Sitzungen. Unter **Nachrichten** lassen sich Projekt und Seite auswählen; die URL erhält diese Auswahl. Je Seite erscheinen 20 Nachrichten mit Absender, Empfänger, Zeitpunkt und Status. `In Inbox` bedeutet wartend, `Abgerufen` bedeutet durch die CLI abgerufen, nicht zwingend inhaltlich bearbeitet. Browser-Abfragen verschieben keine Dateien, quittieren keine Nachrichten und wecken keine Agenten. Das native Senden kann hingegen Empfänger wecken und Modellarbeit auslösen.

## Überprüfung und Korrekturen gegenüber dem Archiv

- Die Claude-Registrierung und das Aufwecken verwenden denselben Socket-Pfad; die abweichenden Feldnamen verhinderten zuvor die Zustellung des Wecksignals.
- Eine dauerhafte, validierte Identitätszuordnung hält Nachrichten nach dem Abmelden beider Teilnehmer sichtbar, solange die zugehörigen AgentPier-Sitzungen bestehen.
- Codex-Weckaufrufe verwenden ausführbare Datei und Profil des Empfängers. Zugangsdaten des Senders werden nicht in dessen Prozessumgebung übernommen.
- Ein fehlgeschlagenes Wecksignal macht eine bereits dauerhaft gespeicherte Nachricht nicht nachträglich zu einem scheinbar fehlgeschlagenen Versand.
- OpenCode bindet MCP-Aufrufe an die tatsächliche aufrufende Sitzung; eine ältere Sitzung aus einem gemeinsam genutzten Server wird nicht wiederverwendet.

`tests/agentbus.test.js` prüft dies mit temporären Profilen, Nachrichten, Prozess-Fixtures und lokalen Test-Sockets. Browser-Tests prüfen Anzeige, URLs, Projektwechsel und Pagination ohne schreibende Bus-Aufrufe. Es wurden keine echten Modellaufträge oder Nachrichten an vorhandene Benutzer-Sitzungen ausgelöst.

## Grenzen und Aufbewahrung

Die Verlaufsansicht prüft maximal 5.000 Dateien pro Anfrage und zeigt beim Erreichen dieser Grenze einen Hinweis. Unbekannte, beschädigte oder nicht zu den eigenen registrierten Teilnehmern gehörende Datensätze werden nicht angezeigt. Entfernte AgentPier-Sitzungen werden nicht mehr als Teilnehmer angeboten; die Anzeige ist kein unabhängiges Langzeitarchiv.

AgentBus-Dateien und die CLI-Prozesse überstehen einen Neustart des Webdienstes. Ein Neustart des Rechners beendet die Prozesse. AgentPier startet gestoppte Modellläufe nicht automatisch neu. Die Trennung dient der korrekten Projekt-/Profilzuordnung und ersetzt keine Betriebssystem-Isolation zwischen Programmen desselben Benutzers.
