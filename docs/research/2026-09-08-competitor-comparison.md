# Wettbewerbsvergleich: Was AgentPier übernehmen sollte

Stand: 8. September 2026. AgentPier-Basis: `fb3ac93` (1.3.7).

## Ergebnis

Die größten unmittelbar nützlichen Übernahmeideen sind zuverlässige mobile
Nachrichtenzustellung, gezieltes Nachladen nach Verbindungsunterbrechungen und
wiederherstellbare Anhänge. Bei Pipelines lohnt sich vor allem die Ergänzung um
externe Auslöser und portable Vorlagen.

**„Wir haben Pipelines“ ist kein belastbares Alleinstellungsmerkmal.** Paseo Hub
implementiert ebenfalls persistente mehrstufige Workflows. AgentPier hat aber
bereits eine interessante Kombination: native CLI-Anbindung, isolierte Accounts,
eigene Worktrees, explizite Prüfergebnisse, begrenzte Korrekturschleifen,
menschliche Freigaben und Wiederaufnahme nach Neustarts. Diese Kombination sollte
im Produkt und in Beispielen sichtbar werden. Eine marktweite Einzigartigkeit
ist durch diesen Vergleich nicht bewiesen.

## Methode und Grenzen

Untersucht wurden offizielle Dokumentation, konkrete Implementierungen und
zugehörige Testfälle. Die externen Repositories wurden nur gelesen; ihre Software
und Tests wurden nicht ausgeführt. Insbesondere wurden weder echte iPhone-
Hintergrundwechsel noch kostenpflichtige CLI-Läufe vergleichend getestet.
Quellcode zeigt einen Lösungsansatz; vorhandene Tests zeigen beabsichtigte
Garantien, keine von uns gemessene Produktionszuverlässigkeit.

Die Links zeigen feste Quellcode-Stände. Entwicklungsstände sind nicht automatisch
bereits veröffentlichte App-Versionen. Happy wurde nicht zusätzlich unabhängig
untersucht; die Aussagen zu Happier gelten nicht automatisch für Happy.

| Projekt                                                                          | Untersuchte Revision                       | Schwerpunkt                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------- |
| [Happier](https://github.com/happier-dev/happier)                                | `927766f69bbd948ea5011ad9a90290fc941d26db` | Zustellung, Accounts, strukturierte Steuerung |
| [Agent of Empires](https://github.com/agent-of-empires/agent-of-empires)         | `4f083edd35f9db557c91edf7a2f914f74a65e564` | Terminal, ACP, mobile Wiederverbindung        |
| [Paseo](https://github.com/getpaseo/paseo)                                       | `da8c1b5c94e752b01d451645e5fa52aba2c1b2f0` | Kanonischer Chatverlauf und Streaming         |
| [Paseo Hub](https://github.com/getpaseo/hub)                                     | `9e07b12c454f8a6b86b3128f82a3c30d0de2da2c` | Workflow-Ausführung und externe Auslöser      |
| [CloudCLI / Claude Code UI](https://github.com/AIGeniusInstitute/claude-code-ui) | `e93c83addb0bc796be239ba37eacf31ec7066c01` | Wiederverbindung laufender Chats              |

## 1. Nachrichten dürfen bei mobilem Verbindungswechsel nicht unklar verschwinden

**Happier löst die Zustellungsverwaltung umfassender.** Die Oberfläche speichert
vor dem Netzwerkaufruf die konkrete Nachricht mit stabiler Identität in einer
Outbox. Die Tests behandeln verlorene Bestätigungen, vorübergehende Fehler und
unklare Zustellung. Die Speicherung ist nach Server und Account getrennt.
Beleg: [Persistenz](https://github.com/happier-dev/happier/blob/927766f69bbd948ea5011ad9a90290fc941d26db/apps/ui/sources/sync/domains/state/pendingOutboxPersistence.ts#L9),
[Zustellungstests](https://github.com/happier-dev/happier/blob/927766f69bbd948ea5011ad9a90290fc941d26db/apps/ui/sources/sync/engine/pending/pendingQueueV2.outboxReplay.test.ts#L124).

AgentPier sendet aktuell direkt an `/sessions/:id/input` und leert den Composer
nach HTTP-Erfolg. Dieser Aufruf enthält keine stabile Nachrichten-ID. Ein
Neuladen der Seite ist deshalb eine andere Situation als das bereits behandelte
kurze Verbergen der App. Siehe
[useChatController.js](../../web/features/chat/useChatController.js).

**Übernahme:** Entwurf und ausgehende Nachricht lokal dauerhaft speichern;
Session-, Account- und Serverbindung explizit machen. Serverseitig dieselbe ID
wiedererkennen und den bekannten Zustellungsstand zurückgeben. Die Oberfläche
unterscheidet mindestens „wartet“, „übergeben“ und „Zustellung unklar“.

Wichtig für unsere Architektur: Ein erfolgreicher tmux-Schreibvorgang beweist
nicht, dass der Provider die Nachricht angenommen hat. Nach einem Absturz zwischen
Schreiben und Quittierung darf dieselbe Eingabe nicht blind erneut an die TUI
gehen. Solche Fälle brauchen Abgleich mit dem Verlauf oder eine sichtbare
Entscheidung des Nutzers. Eine Outbox allein ergibt keine Exactly-once-Garantie.

**Abnahme:** Verbindung unmittelbar vor und nach der Serverannahme trennen;
Seite neu laden; Account wechseln; doppelt auf Senden tippen. Keine heimlich
verdoppelte Eingabe und kein still verlorener Entwurf.

## 2. Nach dem Aufwachen gezielt synchronisieren

**Paseo trennt abgeschlossene Verlaufseinträge von vorläufigem Streaming.**
Ein untersuchter Wiederverbindungstest setzt einen Cursor aus Generation (`epoch`)
und Sequenznummer ein. Nach der Unterbrechung wird der inzwischen abgeschlossene
Eintrag nachgeladen; eine alte vorläufige Textantwort wird nicht erneut als
Streaming-Start ausgespielt. Das ist ein konkreter Vertrag zwischen Server und
Client, der Doppelanzeigen und Lücken behandelbar macht.
Beleg: [Reconnect-Vertrag samt Test](https://github.com/getpaseo/paseo/blob/da8c1b5c94e752b01d451645e5fa52aba2c1b2f0/packages/server/src/server/daemon-e2e/timeline-reconnect-contract.e2e.test.ts#L60).

**Happier ergänzt Cursor-Nachladen um Snapshot-Reparatur**, wenn der Cursor nicht
mehr verwendbar ist. Der sichere Zeitpunkt für die Cursor-Fortschreibung ist
explizit getestet.
Beleg: [Synchronisation](https://github.com/happier-dev/happier/blob/927766f69bbd948ea5011ad9a90290fc941d26db/apps/ui/sources/sync/runtime/orchestration/socketReconnectViaChanges.ts#L9),
[Tests](https://github.com/happier-dev/happier/blob/927766f69bbd948ea5011ad9a90290fc941d26db/apps/ui/sources/sync/runtime/orchestration/socketReconnectViaChanges.test.ts#L41).

**CloudCLI zeigt eine kleinere Zwischenlösung:** laufende Runs erhalten
sequenzierte Ereignisse. Eine erneute Subscription liefert Arbeitszustand,
offene Freigaben und fehlende Ereignisse. Der Puffer liegt allerdings im Speicher,
ist auf 5.000 Ereignisse begrenzt und abgeschlossene Runs werden nur kurz
aufbewahrt. Abgeschlossene Verläufe kommen wieder über REST. Das ist keine
prozessübergreifende dauerhafte Zustellung.
Beleg: [Run-Registry](https://github.com/AIGeniusInstitute/claude-code-ui/blob/e93c83addb0bc796be239ba37eacf31ec7066c01/server/modules/websocket/services/chat-run-registry.service.ts#L20),
[Subscription und Replay](https://github.com/AIGeniusInstitute/claude-code-ui/blob/e93c83addb0bc796be239ba37eacf31ec7066c01/server/modules/websocket/services/chat-websocket.service.ts#L230).

AgentPier pollt den sichtbaren Chat etwa alle 1,5 Sekunden und liefert Ausschnitte
mit bis zu 500 Nachrichten. Sichtbarkeit, `pageshow`, Online-Ereignisse und
veraltete Requests werden bereits behandelt. Polling bedeutet nicht automatisch
Datenverlust. Es fehlt aber ein expliziter Vertrag für Änderungen seit einem
bekannten Stand. Siehe [Polling](../../web/lib/visible-polling.js) und
[ChatStore](../../server/features/chat/chat-store.js).

**Übernahme:** zunächst HTTP-Antworten mit Verlaufsrevision, stabilen Eintrags-IDs,
Änderungen seit Cursor und vollständigem Ersatz bei ungültigem Cursor. Native
History-Dateien können umgeschrieben werden; bloße Zeilennummern reichen deshalb
nicht. Vorläufige und endgültige Antworten müssen getrennt modelliert werden.
WebSockets/SSE erst ergänzen, wenn Messungen den Nutzen zeigen.

**Abnahme:** Antwort während Hintergrundpause abschließen; alte History ersetzen;
Cursor ablaufen lassen; Server neu starten. Danach identischer Verlauf ohne
Duplikate, korrekter Arbeitsstatus und erhaltene Leseposition. Übertragene Bytes
und Zeit bis zur aktuellen Ansicht vorher/nachher messen.

## 3. Terminal-Wiederverbindung und Eingabebesitz

**Agent of Empires behandelt das Aufwachen des Terminals ausdrücklich:**
Visibility-, Netzwerk- und Pageshow-Ereignisse stoßen Wiederverbindung an;
Geometrie wird wiederhergestellt, und vor Eingabe wird die Steuerungsberechtigung
zwischen Clients geklärt. Tests simulieren Eigentümerwechsel und mobile
Tastaturgrößen. Beleg: [Wake-Handling](https://github.com/agent-of-empires/agent-of-empires/blob/4f083edd35f9db557c91edf7a2f914f74a65e564/web/src/hooks/useLiveTerminal.ts#L420),
[Ownership-Tests](https://github.com/agent-of-empires/agent-of-empires/blob/4f083edd35f9db557c91edf7a2f914f74a65e564/web/src/hooks/useLiveTerminal.sizeOwner.test.ts#L97),
[Keyboard-Tests](https://github.com/agent-of-empires/agent-of-empires/blob/4f083edd35f9db557c91edf7a2f914f74a65e564/web/src/components/__tests__/MobileLiveTerminal.keyboardResize.test.tsx#L1).

AgentPiers [Terminal-Hook](../../web/features/terminal/useTerminalConnection.js)
verbindet nach `onclose` erneut und beobachtet Größenänderungen. Eine entsprechende
Wake-Behandlung oder Besitzerverhandlung ist dort nicht vorhanden. Die bereits
vorhandene Chat-Wake-Behandlung ist davon zu unterscheiden.

**Übernahme:** zuerst gezielte Terminal-Revalidierung beim Zurückkehren.
Anschließend bei Bedarf einen expliziten steuernden Client und beobachtende
Clients einführen, damit Handy und Desktop nicht gegenseitig die Terminalgröße
verändern. Den Terminalrenderer dafür nicht austauschen.

**Abnahme:** Desktop und Handy gleichzeitig öffnen, Handy sperren und aufwecken,
Tastatur mehrmals einblenden; Session bleibt erreichbar und ihre Größe stabil.
Ein echter iPhone-Test bleibt notwendig: simulierte Viewports beweisen kein
korrektes iOS-Tastaturverhalten.

## 4. Anhänge: Wiederaufnahme und nachvollziehbare Fehler

**Happier behält bereits erfolgreich hochgeladene Dateien bei einem erneuten
Versuch.** Upload-Zustände enthalten Fortschritt, Fehler und bestätigte Pfade;
eine stabile Nachrichten-ID gruppiert die Dateien. Das ist Wiederverwendung
fertiger Uploads, kein Beleg für Byte-genau fortsetzbare Uploads.
Beleg: [Upload-Implementierung](https://github.com/happier-dev/happier/blob/927766f69bbd948ea5011ad9a90290fc941d26db/apps/ui/sources/components/sessions/attachments/uploadAttachmentDraftsToSession.ts#L81),
[Retry-Tests](https://github.com/happier-dev/happier/blob/927766f69bbd948ea5011ad9a90290fc941d26db/apps/ui/sources/components/sessions/attachments/uploadAttachmentDraftsToSession.test.ts#L157).

AgentPier unterstützt schon Bilder und Dateien sowie begrenzte, accountgebundene
Uploads. Die Verbesserung ist daher eine wiederherstellbare Anhangsliste mit
Status pro Datei und Wiederverwendung bestätigter Uploads. Ansatzpunkt:
[useChatAttachments.js](../../web/features/chat/useChatAttachments.js).

Für die früheren Bildprobleme ist zusätzlich ein **AgentPier-spezifischer
Vorschlag**, kein hier nachgewiesener Wettbewerbsvorteil: freigegebene
Assistant-Bildartefakte optional in einen verwalteten Speicher übernehmen.
Originalpfade können später verschwinden. Dabei die vorhandene Trennung von
Tool-Ausgaben und sichtbaren Chatbildern, Dateiprüfung und Zugriffskontrolle
beibehalten. „Quelle gelöscht“, „Zugriff verweigert“ und „Format nicht unterstützt“
sollten unterscheidbar sein.

**Abnahme:** drei Dateien hochladen, zweite scheitert, Seite neu laden und
wiederholen; erfolgreiche Dateien bleiben erhalten. Ein verschwundenes
Originalbild erzeugt einen erklärbaren Zustand. Aufbewahrung und Löschung der
verwalteten Kopien müssen vor Einführung feststehen.

## 5. Strukturierte CLI-Steuerung als optionaler Betriebsmodus

Happier startet lokal tatsächlich native interaktive CLIs, verwendet für die
Remote-Steuerung aber auch strukturierte Laufzeiten. Beispielsweise erfolgt der
Claude-Modellwechsel dort über das Agent SDK. AoE unterscheidet tmux-Sessions von
ACP-Sessions; letztere besitzen ausdrücklich keinen tmux-Pane.
Beleg: [Happier lokaler Codex-Start](https://github.com/happier-dev/happier/blob/927766f69bbd948ea5011ad9a90290fc941d26db/apps/cli/src/backends/codex/codexLocalLauncher.ts#L391),
[Claude SDK-Modellwechsel](https://github.com/happier-dev/happier/blob/927766f69bbd948ea5011ad9a90290fc941d26db/apps/cli/src/backends/claude/remote/claudeRemoteAgentSdk.ts#L544),
[AoE-Backend-Unterscheidung](https://github.com/agent-of-empires/agent-of-empires/blob/4f083edd35f9db557c91edf7a2f914f74a65e564/src/session/instance/status_update.rs#L211).

**Übernahme:** kurzfristig eine Capability-Matrix pro Provider und Betriebsmodus:
Modellwechsel, Anhänge, Freigaben, Fortsetzen und belastbare Statusquelle.
Konfiguriert, angefordert und tatsächlich bestätigt dürfen nicht dasselbe bedeuten.
Langfristig kann ein optionaler strukturierter Chat-Treiber sinnvoll sein.
Native TUI-Sessions bleiben ein eigener Vertrag; ein SDK-Runner ist kein
transparenter Ersatz für dieselbe laufende TUI.

AgentPier besitzt bereits native Request-Kanäle und strukturierte
Pipeline-Ausführung. Das Projekt pauschal als „nur Terminal-Scraping“ zu
beschreiben wäre falsch. Unsere Pipeline-Fertigmeldung soll weiterhin auf
nativem Turn-Ende plus aktuellem Versuchsergebnis beruhen, nicht auf einem
heuristischen „idle“-Status.

Auch Persistenz muss präzise benannt werden: AoE speichert ACP-Verlaufsereignisse
mit Sequenznummern auf Disk. Der getrennte Runner-Puffer während einer
Daemon-Unterbrechung ist laut eigener Dokumentation dagegen begrenzt und ohne
Disk-Journal oder Peer-ACK. Beleg: [Event-Store](https://github.com/agent-of-empires/agent-of-empires/blob/4f083edd35f9db557c91edf7a2f914f74a65e564/src/acp/event_store.rs#L1),
[explizite Grenzen](https://github.com/agent-of-empires/agent-of-empires/blob/4f083edd35f9db557c91edf7a2f914f74a65e564/docs/development/internals/structured-view.md#L5).

## 6. Pipelines: bestehende Stärken erhalten, Auslöser ergänzen

**Paseo Hub ist ein tatsächlicher Workflow-Vergleich.** Die Engine verwaltet
persistierte Schritte, beansprucht Arbeit zeitlich begrenzt, gleicht abgeschlossene
Ausführungen ab und setzt nach Unterbrechungen fort. Der untersuchte Ablauf wählt
nacheinander den nächsten ausstehenden Schritt; daraus folgt kein Nachweis eines
beliebigen parallelen DAG-Schedulers. Ein Test behandelt Neustart nach
strukturiertem Abschluss ohne doppelte nachfolgende Ausführung.
Beleg: [Engine](https://github.com/getpaseo/hub/blob/9e07b12c454f8a6b86b3128f82a3c30d0de2da2c/src/workflows/engine.ts#L440),
[Neustart-Test](https://github.com/getpaseo/hub/blob/9e07b12c454f8a6b86b3128f82a3c30d0de2da2c/src/workflows/engine.test.ts#L928).

Besonders interessant ist die transaktionale Annahme externer Ereignisse aus
GitHub, Slack, Discord und Linear: vorhandene Zustellbelege werden wiedererkannt,
und die ausgewählte Konfigurationsrevision wird der Annahme zugeordnet.
Beleg: [Trigger-Annahme](https://github.com/getpaseo/hub/blob/9e07b12c454f8a6b86b3128f82a3c30d0de2da2c/src/db/trigger-acceptance.ts#L32).
Das Projekt bezeichnet sich selbst als frühe Entwicklung mit möglichen
inkompatiblen Änderungen und Datenverlust; Funktionsumfang ist daher kein
Reifegradbeweis. [README](https://github.com/getpaseo/hub/blob/9e07b12c454f8a6b86b3128f82a3c30d0de2da2c/README.md#L16).

**Happiers untersuchter Automation-Executor löst eine andere Ebene:** sein
Erfolgsstatus folgt auf Session-Start beziehungsweise Einreihen einer Nachricht,
nicht auf ein bestandenes Arbeitsergebnis. Sein Aktionskatalog bietet zusätzlich
strukturierte Review- und Delegationsaktionen. Das ist nützlich, aber kein Beleg
für AgentPier-äquivalente Prüfgates.
Beleg: [Automation-Abschluss](https://github.com/happier-dev/happier/blob/927766f69bbd948ea5011ad9a90290fc941d26db/apps/cli/src/daemon/automation/automationRunExecutor.ts#L164),
[Aktionskatalog](https://github.com/happier-dev/happier/blob/927766f69bbd948ea5011ad9a90290fc941d26db/packages/protocol/src/actions/actionIds.ts#L27).

AgentPier hat bereits eingefrorene Graphen und Profile, eigene Worktrees,
versuchsspezifische Verdicts, begrenzte Review-Schleifen, menschliche Freigaben,
Prüfbefehle außerhalb des agentbearbeitbaren Repositories, Checkpoints sowie
Wiederaufnahme und gesonderte PR-Wiederholung. Siehe [Pipeline-Vertrag](../pipelines.md).
Diese Eigenschaften sind in der untersuchten Kombination ein sinnvoller
Positionierungsschwerpunkt; nicht jedes andere Projekt wurde auf jede einzelne
Eigenschaft vollständig geprüft.

**Übernahme in drei Schritten:**

1. Vorlagen für Bugfix, Feature mit Review und Sicherheitsprüfung; jede Vorlage
   erklärt Artefakte, Gates und erwartete menschliche Entscheidungen. Export und
   Import enthalten keine Credentials. Repository-Inhalte dürfen lokale
   vertrauenswürdige Prüfkonfiguration nicht still überschreiben.
2. Einen authentifizierten Trigger-Einstieg mit stabiler Ereignis-ID einführen,
   der ausschließlich die vorhandene Pipeline-Engine startet. Annahme und
   tatsächliches Run-Ergebnis getrennt darstellen. Zuerst einen GitHub-Auslöser
   oder Zeitplan umsetzen, nicht sofort vier Integrationen.
3. Ein gemeinsames validiertes Aktionsschema für UI, API und gegebenenfalls MCP:
   etwa Review starten oder fehlgeschlagene Prüfung wiederholen. Bestehende
   serverseitige Berechtigungen und Freigaben bleiben maßgeblich.

**Abnahme:** dasselbe Ereignis mehrfach zustellen; beim Start abstürzen;
Konfiguration während eines Runs ändern; PR-Veröffentlichung unterbrechen.
Es darf kein doppelter Run entstehen, die eingefrorene Definition bleibt
nachvollziehbar und ein erfolgreich angenommener Trigger ist noch kein
bestandener Pipeline-Lauf.

## Reihenfolge und Größenordnung

Aufwand ist eine grobe Planungseinschätzung für AgentPier, keine gemessene
Umsetzungsdauer. „Groß“ bedeutet Architekturarbeit über mehrere Teiländerungen.

| Reihenfolge | Änderung                                                   | Aufwand          | Nutzen                                                   |
| ----------- | ---------------------------------------------------------- | ---------------- | -------------------------------------------------------- |
| 1           | Dauerhafte Entwürfe/Outbox samt unklarer Zustellung        | Mittel bis groß  | Vertrauen beim mobilen Senden                            |
| 2           | Terminal-Wake-Revalidierung; gezielte iPhone-Szenarien     | Klein bis mittel | Rückkehr in die App                                      |
| 3           | Chat-Cursor, stabile Identitäten und Snapshot-Fallback     | Mittel bis groß  | Eindeutige Wiederherstellung und weniger Vollübertragung |
| 4           | Upload-Status und Wiederaufnahme pro Datei                 | Mittel           | Weniger verlorene Anhänge und Wiederholungen             |
| 5           | Pipeline-Vorlagen und ein deduplizierter Trigger           | Mittel           | Sichtbarer Nutzen über einen CLI-Chat hinaus             |
| 6           | Capability-Matrix und gemeinsame Aktionen                  | Mittel           | Ehrliche, konsistente Steuerung                          |
| Später      | Optionaler strukturierter Runner, mehrere Hosts, Container | Groß             | Neue Betriebsmodelle mit eigenen Integrationskosten      |

Für eine erste kleine Änderung eignet sich Terminal-Wake-Revalidierung. Für das
wichtigste zusammenhängende Vorhaben empfehle ich mobile Zustellung einschließlich
Entwurf, Anhangsmanifest, Serverbeleg und sichtbarem Unsicherheitszustand. Erst
anschließend den Transport aus Optimierungsgründen austauschen.

Nicht unmittelbar übernehmen: komplette UI- oder Sprachmigrationen, eine zweite
Workflow-Engine, unkontrollierte automatische Wiederholungen an tmux oder
stillschweigende Account-Wechsel in laufenden Pipeline-Profilen.

## Quellcodeübernahme und Lizenzen

In dieser Recherche wurde kein fremder Implementierungscode in AgentPier kopiert.
Beobachtete Root-Lizenzen:

| Projekt          | Lizenz im untersuchten Stand                                                                                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Happier          | [MIT](https://github.com/happier-dev/happier/blob/927766f69bbd948ea5011ad9a90290fc941d26db/LICENCE)                                                                                                                                                                               |
| Agent of Empires | [MIT](https://github.com/agent-of-empires/agent-of-empires/blob/4f083edd35f9db557c91edf7a2f914f74a65e564/LICENSE), zusätzliche [Drittanbieterhinweise](https://github.com/agent-of-empires/agent-of-empires/blob/4f083edd35f9db557c91edf7a2f914f74a65e564/THIRD_PARTY_NOTICES.md) |
| Paseo            | [Apache-2.0 mit Drittanbieterabgrenzung](https://github.com/getpaseo/paseo/blob/da8c1b5c94e752b01d451645e5fa52aba2c1b2f0/LICENSE)                                                                                                                                                 |
| Paseo Hub        | [Apache-2.0](https://github.com/getpaseo/hub/blob/9e07b12c454f8a6b86b3128f82a3c30d0de2da2c/LICENSE)                                                                                                                                                                               |
| CloudCLI         | [AGPL-3.0](https://github.com/AIGeniusInstitute/claude-code-ui/blob/e93c83addb0bc796be239ba37eacf31ec7066c01/LICENSE)                                                                                                                                                             |

Dies ist eine Quelleninventur, keine Aussage über die Lizenzverträglichkeit einer
späteren Übernahme. Bei konkretem Kopieren sind Dateiprovenienz und Hinweise
zusammen mit der gewählten AgentPier-Lizenz zu prüfen. Die beschriebenen
Architekturideen können zunächst mit eigenen Implementierungen und eigenen
Regressionstests bewertet werden.
