# AgentPier

[English](README.md) · [Mitwirken](CONTRIBUTING.md) · [Sicherheit](SECURITY.md) · [Apache-2.0](LICENSE)

Dein lokaler Workspace für **Codex, Claude Code und OpenCode**: native Terminals, eine mobile Chatansicht, Aufgabenlisten, mehrere Accounts mit gemeinsamen CLI-Erweiterungen und GitHub-Repositories.

## Lokal ausprobieren

Voraussetzungen: macOS oder Linux, Node.js **22.13+**, tmux und Git. Vorhandene CLIs werden erkannt. Fehlende Codex-, Claude-Code- und OpenCode-CLIs lassen sich unter **Deine Tools → CLI installieren** einrichten; dafür benötigt der Server auch npm.

```sh
git clone https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier.git
cd agent-pier
npm ci
npm run build
npm start
```

Öffnen: **http://127.0.0.1:4380**. Das startet nur den lokalen Webdienst. `Ctrl+C` beendet ihn; die nativen CLI-Sitzungen laufen in ihrem eigenen tmux-Server weiter. Autostart und Fernzugriff werden ausschließlich durch separate, explizite Einrichtung aktiviert.

Beim ersten Öffnen legst du den einzelnen Benutzer an; danach ist eine Anmeldung
erforderlich. Die Einrichtung funktioniert auch über den konfigurierten erlaubten
Fernzugriff. Schließe sie ab, bevor du den Zugang teilst. Details: [Login](docs/login.md).

Mobile Entwürfe und Zustellstatus bleiben erhalten. Das Terminal verbindet sich
bei der Rückkehr neu, und der Chat lädt Änderungen gezielt nach. Unterbrochene
Datei-Uploads lassen sich nach einem Reload einzeln wiederholen; erfolgreiche
Anhänge bleiben erhalten. [Wiederherstellung](docs/mobile-recovery.md).

Die Anleitungen für den dauerhaften Betrieb stehen unter [Mac mini](docs/installation.md) und [Linux](docs/linux.md). Der [versionierte Installer](docs/research/operations-portability.md#installer-and-exact-commands) installiert ein passendes Release mit separatem Datenverzeichnis; Abhängigkeiten und Autostart benötigen die expliziten Optionen `--install-dependencies` und `--service`. Er bestätigt bei Dienstinstallation die gestartete Version per Healthcheck. Ein gebautes Release-Artefakt wird vorausgesetzt; eine bereits veröffentlichte Version ist damit nicht zugesichert.

## Sitzungen und Chat

- **Neue Sitzung:** CLI, passenden nativen Zugang oder zentrale Provider-Verbindung, Modell, Namen, vorhandenen Projektordner und optional einen Startmodus wählen. Claude und OpenCode starten vorausgewählt mit Auto; Codex startet mit Standard. Standard übernimmt die nativen Einstellungen. Codex **YOLO** setzt `--yolo` (ohne Sandbox und Freigaben), Claude **Auto** setzt `--permission-mode auto`, OpenCode **Auto** setzt `--auto`. Claude entscheidet weiterhin mit seinem Auto-Classifier; OpenCode behält explizite Verbote bei. Version, Modell und Organisationsrichtlinien können die Verfügbarkeit einschränken.
- **Shell:** Eine lokale Shell direkt unter **Deine Tools** starten, ohne Konto, API-Key oder Anmeldung. Die konfigurierte zsh/bash/sh wird verwendet, ansonsten zsh → bash → sh. Shell-Sitzungen haben ausschließlich eine Terminalansicht.
- **Arbeitsverzeichnis:** Unter **Einstellungen** einen vorhandenen Standardordner speichern. Neue Sitzungen übernehmen ihn; ein ausdrücklich ausgewähltes Projekt hat Vorrang.
- **Terminal:** Die echte native TUI mit Farben, Cursor, Tastatur, Maus und Größenanpassung. Login und native Auswahlmenüs bleiben hier erreichbar; unterstützte Freigaben und Rückfragen lassen sich zusätzlich im Chat beantworten.
- **Chat:** Nachrichten mit Markdown und Codeblöcken, aufklappbare Tool-Aktivitäten und eine Aufgabenliste links. Auf dem Handy öffnet sich diese Ansicht standardmäßig. Die Aufgaben lassen sich links als eigene Seitenleiste einblenden, ohne die Nachrichtenhöhe zu verkleinern. Auf breiten Ansichten stehen sie direkt links neben dem Chat. Keine TUI-Statusleisten, Eingabe-Prompts oder ANSI-Reste im Chat.
- **Bilder:** Lokale Bildpfade aus eigenen Nachrichten und Antworten des Assistenten erscheinen als Vorschaubilder mit Vergrößerung. Interne Tool-Aufrufe erzeugen keine Bildvorschauen; ihre Pfade bleiben in den aufklappbaren Details lesbar. Unterstützte Rasterbilder werden vom AgentPier-Rechner geladen; relative Pfade beziehen sich auf das Projekt. Fehlende Dateien erhalten einen Hinweis. Externe Bild-URLs werden nicht automatisch geladen.
- **Dateien und Bilder anhängen:** Dateien lassen sich auf die Chatfläche ziehen, aus der Zwischenablage einfügen oder über die Dateiauswahl anhängen, bis zu 8 pro Nachricht und höchstens 10 MiB je Datei. Bilder erhalten Vorschauen; beim Senden folgen die Dateipfade dem Nachrichtentext. Neue Sitzungen erhalten eine CLI-Freigabe für ihren Anhangsordner. Bereits laufende Sitzungen behalten den bisherigen Datei-Upload; ihr CLI kann eine Lesefreigabe verlangen. Shell-Sitzungen unterstützen keine Anhänge.
- **Drag-and-drop am Desktop:** Dateien oder Bilder auf Chat oder Terminal ziehen. Die Drop-Fläche erscheint während des Ziehens. Im Chat werden sie dem Entwurf angehängt; im Terminal wird nach dem Upload der zitierte Pfad ohne Enter eingefügt. Fehlgeschlagene Terminal-Uploads lassen sich wiederholen. Auf Touch-Geräten bleibt die Dateiauswahl bestehen.
- **Aufgaben:** Übernimmt strukturierte Aufgabenmeldungen von Claude (`TodoWrite`, `TaskCreate`, `TaskUpdate`), Codex (`update_plan`) und OpenCode (`todowrite`). Sind keine Aufgaben im gespeicherten Verlauf verfügbar, bleibt die Liste leer. Prosa-Checklisten werden nicht als CLI-Aufgaben ausgegeben.
- **Nachrichten senden:** Sendet Text und Enter an dieselbe laufende CLI-Sitzung. AgentPier startet keinen zweiten Modelllauf. Offene native Rückfragen werden zuerst über ihre Chat-Karte oder im Terminal beantwortet. Währenddessen sind gewöhnliche Chat-Eingaben und Modellwechsel gesperrt.
- **Tastatur:** Desktop: Enter sendet, Shift+Enter erzeugt eine neue Zeile. Touch-Geräte: Enter erzeugt eine neue Zeile; nur der Senden-Button sendet. IME-Eingaben lösen keinen vorzeitigen Versand aus.
- **Modell:** Das Modellfeld zeigt die native Modellanzeige. Ein Klick öffnet die verfügbaren Modelle derselben laufenden CLI als Dropdown; Codex-Denkstufen folgen als eigener Schritt. OpenCode unterstützt die native Modellsuche und zeigt vorhandene Provider-Beschreibungen. Claude verwendet, wenn verfügbar, den Wechsel nur für diese Sitzung. Während einer Auswahl wird der Chatversand gesperrt; der Nachrichtenentwurf bleibt erhalten. Wenn keine aktuelle Anzeige lesbar ist, wird ein früherer Wert ausdrücklich als **Zuletzt bestätigt** bezeichnet.
- **Automatische Chat-Zuordnung:** Neue CLI-Sitzungen verbinden ihren Reader automatisch: Claude über die native Sitzungs-ID, Codex zusätzlich über den eigenen laufenden Prozess und dessen geöffneten Verlauf, OpenCode über die tatsächlich angezeigte Unterhaltung. Das funktioniert auch ohne AgentBus und bei mehreren Sitzungen im selben Projekt. Bereits laufende Codex-Sitzungen können über ihren Prozess erkannt werden. Für ältere oder externe Sitzungen ohne eindeutige Zuordnung bleibt „Verlauf verknüpfen“ als manuelle Auswahl desselben Accounts und Projekts verfügbar. Shell-Sitzungen haben keinen Reader.
- **Stoppen / Entfernen:** Stoppen beendet gezielt eine Sitzung. Entfernen ist anschließend möglich und löscht ihre AgentPier-Metadaten, gespeicherte Ansicht, Verknüpfung und angehängte Bilder. Provider-eigene Chatverläufe bleiben erhalten.

Die Chatansicht liest die vom CLI gespeicherten Nachrichten und aktualisiert sich regelmäßig. Sie ist kein Zeichen-für-Zeichen-Streaming. Neue unterstützte Coding-Sitzungen erhalten zusätzlich einen nativen Kanal für Freigaben und Rückfragen; bestehende Sitzungen werden nicht nachträglich umgestellt. Claude benötigt lokale JSONL-Transkripte; Codex einen App-Server mit lesender History-API; OpenCode die Befehle `session list --format json` und `export`. Die Verfügbarkeit einzelner Aufgaben-/Tool-Details hängt von der CLI-Version und deren gespeicherten Daten ab. Codex-Plantext alleine enthält keine strukturierten Aufgaben; AgentPier nutzt dafür vorhandene Rollout-Aufrufe. Angezeigt werden bis zu 500 Nachrichten, bei paginierten Codex-Verläufen aus den neuesten 1.000 Turns. Claude-Transkripte über 64 MiB bleiben im Terminal zugänglich.

Das Modellfeld ist direkt am Nachrichtenfeld verankert; die Auswahl öffnet sich nach oben und passt sich auch an verkleinerte mobile Ansichten an. Die Modellauswahl bildet erkannte native Menüs ab, keine fest hinterlegte Modellliste. Sie prüft vor jeder Auswahl den aktuellen Menüzustand. Eigene Tastaturbelegungen, schmale native Terminals oder neue CLI-Menüs können **Im Terminal fortfahren** erfordern. Codex benötigt für `/model` ein leeres natives Eingabefeld; Claude und OpenCode verwenden ihre Tastenkürzel und erhalten native Entwürfe. Zusätzliche Provider-Anmeldungen und Bestätigungen bleiben im Terminal. Ein Abbruch einer nachfolgenden Denkstufenauswahl macht einen bereits vollzogenen nativen Modellwechsel nicht automatisch rückgängig.

Die Navigation bündelt Verwaltungsseiten unter **Verwaltung**. Verwaltung und Sitzungen lassen sich unabhängig aufklappen; die Auswahl bleibt beim Neuladen erhalten. Direkte Seitenlinks öffnen die passende Gruppe. Sitzungen zeigen **Arbeitet**, **Bereit**, **Wartet auf Eingabe** oder **Aktivität unbekannt** anhand der erkannten nativen CLI-Anzeige. Eine laufende Shell wird als **Terminal aktiv** angezeigt.

Die Aktivitätsanzeige liest nur den sichtbaren nativen Terminalbereich, ohne Eingaben oder Modellaufträge. Sie aktualisiert sich etwa alle drei Sekunden. Unbekannte CLI-Darstellungen und veraltete Spinner bleiben als unbekannt markiert; „Arbeitet“ ist keine Aussage über den Abschluss einzelner Aufgaben.

Seiten, Sitzungen, Terminal/Chat, Verwaltungsprofile sowie AgentBus-Projekt und Nachrichtenseite haben eigene URLs. Die Chatansicht verwendet `/sessions/<id>/chat`; bestehende `/reader`-Links bleiben gültig und werden auf `/chat` umgestellt. Neuladen sowie Zurück/Vorwärts erhalten die gewählte Ansicht. Auf Mobilgeräten lässt die kompakte Kopfzeile mehr Platz für Nachrichten.

## Projektwissen und externe Modellanbieter

Unter **Projektwissen** verwaltest du gemeinsame Repository-Notizen: suchen, bearbeiten, Versionen ansehen und archivieren. Neue Coding-Sitzungen bekommen automatisch die projektgebundenen Memory-Werkzeuge. Git-Worktrees teilen das Wissen; unabhängige Klone und andere Projekte bleiben getrennt. Gleichzeitige Änderungen werden über Versionsprüfungen aufgelöst. Details: [Memory](docs/memory.md).

**OpenRouter**, **Z.ai API** und **Z.ai Coding Plan** werden als zentrale Provider-Verbindungen einmal eingerichtet und beim Sitzungsstart für eine unterstützte CLI gewählt. Native Konten bleiben an ihre jeweilige CLI gebunden. Bestehende kontogebundene Provider-Konfigurationen bleiben nutzbar. CLI-spezifische Modelle, Katalogaktualisierung und ausgewiesene Kontextgrenzen gehören zur Auswahl. Für Codex mit Z.ai muss Responses-Zugriff ausdrücklich bestätigt werden. Konfiguriertes Modell und tatsächlich gemeldetes Modell bleiben unterscheidbar; erforderliche Modellwechsel erfolgen über eine neue Sitzung. Details und Einschränkungen: [Provider](docs/providers.md).

Der Chat zeigt verfügbare native Kontextwerte und Subagenten-Aktivitäten. Fehlende Werte werden als unbekannt behandelt; [Messgrundlagen und Grenzen](docs/chat-observability.md) sind dokumentiert. Eigene Nachrichten stehen rechts als kompakte Sprechblasen, und die Sitzungsnavigation zeigt den Projektordner.

## Accounts

Unter **Konten** zusätzliche native Coding-CLI-Profile anlegen. Ein Claude-Konto gilt nur für Claude, ein Codex-Konto nur für Codex und ein OpenCode-Konto nur für OpenCode. Die lokale Shell benötigt kein Konto und erscheint hier nicht. Ohne API-Key über **Anmelden** den nativen Login öffnen. Codex verwendet Geräte-Anmeldung; Claude und OpenCode ihre eigenen Verfahren. Bei API-Key-Profilen wird dieser Schritt nicht angeboten.

Lokale Profile verwenden die bestehende Standard-Anmeldung des Tools. Eigene Profile erhalten getrennte Anmelde- und Verlaufsordner; MCPs, Plugins, Marketplaces, Skills und eigene Agenten teilen sie standardmäßig mit allen Konten derselben CLI. Claude setzt sowohl `CLAUDE_CONFIG_DIR` als auch `CLAUDE_SECURESTORAGE_CONFIG_DIR`; Codex nutzt `CODEX_HOME`, OpenCode getrennte XDG-Verzeichnisse. Profile teilen weiterhin die normalen Projektdateien und Benutzerrechte des Rechners.

API-Keys sind optional für Codex/OpenAI und Claude/Anthropic, bei OpenCode für den OpenAI-Provider. Weitere OpenCode-Provider werden über dessen native Anmeldung verbunden. Ein leeres Key-Feld beim Bearbeiten behält den bisherigen Key. Vor dem Wechsel eines Keys oder Löschen eines Accounts dessen Sitzungen beenden. CLI-eigene macOS-Keychain-Einträge werden beim Entfernen eines Profils nicht automatisch gelöscht.

## SSH-Serverzugänge

Unter **Einstellungen → Serverzugänge** verwaltest du benannte, umbenennbare SSH-Schlüssel und wählst sie für einen oder mehrere Hosts mit bestätigtem Fingerabdruck aus. Vorhandene AgentPier-Zugänge werden automatisch übernommen. Du kannst sie beim Start oder in einer bereits laufenden Sitzung zuordnen und den Verbindungsbefehl dem Agenten geben. Die Zuordnung ist keine Sicherheitsisolation zwischen Prozessen desselben Betriebssystembenutzers. SSH-Zugänge und Schlüssel sind in dieser ersten Version nicht in AgentPier-Sicherungen enthalten. Details: [SSH-Zugänge](docs/ssh-access.md).

## GitHub und GitHub Enterprise

Unter **Repositories** kannst du mehrere benannte Zugänge speichern, auch mehrere für denselben Host:

| Name   | Host                  |
| ------ | --------------------- |
| Privat | `https://github.com`  |
| Arbeit | `https://xxx.ghe.com` |

Zum Klonen Zugang, Repository (`owner/repo` oder vollständige HTTPS-URL), bestehenden übergeordneten Ordner und neuen Ordnernamen auswählen. **Öffentlich · github.com** benötigt keinen Token. Mit einem Zugang stehen durchsuchbare Dropdowns für Organisationen und Repositories zur Verfügung. Der Zielordner lässt sich per Ordnerauswahl wählen und dort neu anlegen. Die Suche lädt bis zu 1.000 zugängliche Repositories und weist auf ein erreichtes Limit hin; vollständige URLs können immer manuell eingegeben werden. Nach erfolgreichem Klonen startet **Sitzung starten** einen CLI-Dialog mit diesem Projektverzeichnis.

Tokens werden nur für den ausgewählten HTTPS-Host verwendet. Sie landen weder in der Repository-URL noch in `.git/config`, Browserantworten oder Fehlermeldungen. Bestehende Zielordner werden nicht überschrieben; fehlgeschlagene/abgebrochene Klone räumen nur ihre eigenen neuen Ordner auf. Weiterleitungen und rekursive Submodule sind beim Klonen deaktiviert. Verwende die endgültige HTTPS-URL des Repositories. Für Enterprise-Zertifikate werden `GIT_SSL_CAINFO`/`GIT_SSL_CAPATH` und die Proxy-Umgebung berücksichtigt; TLS-Prüfung bleibt aktiv.

Die Zugangsdaten werden nicht in deinen globalen Git-Credential-Manager geschrieben. Neue Coding-CLI-Sitzungen erhalten eine eigene GitHub-CLI-Konfiguration und hostbezogene Git-Anmeldung. Je Host wird der unter **Standard für Agenten** markierte Zugang verwendet; bei einem über AgentPier geklonten Projekt hat dessen gewählter Zugang für diesen Host Vorrang. Mehrere Hosts, etwa `github.com` und `firma.ghe.com`, können gleichzeitig verfügbar sein. Änderungen am Token oder dessen Entfernung aktualisieren die erzeugten Konfigurationen; ein neuer Standard gilt für neue Sitzungen. Das Entfernen eines Zugangs löscht keine geklonten Projekte.

Die Oberfläche verwendet Anthrazit mit orangefarbenen Akzenten. Das native Terminal behält seine neutralen Standardfarben und die ANSI-/True-Color-Ausgabe der CLI. Ein SVG-Favicon und ein ICO-Fallback sind enthalten.

## Fehlende CLIs installieren

Unter **Deine Tools** öffnet **CLI installieren** eine Vorschau mit offiziellem Installer und Zielpfad. Erst **Jetzt installieren** startet den Download auf dem AgentPier-Server. Status und Fehler bleiben beim Schließen des Dialogs erhalten; fehlgeschlagene Versuche lassen sich wiederholen. Nach erfolgreicher Versionsprüfung kann direkt eine Sitzung gestartet werden.

AgentPier verwendet standardmäßig die offiziellen Shell-Installer von [Codex](https://chatgpt.com/codex/install.sh), [Claude Code](https://claude.ai/install.sh) und [OpenCode](https://opencode.ai/install). Codex und Claude liegen unter `~/.local/bin`, OpenCode unter `~/.opencode/bin` des **Serverbenutzers**. Damit bleiben die nativen Update-Verfahren erhalten; Claude und OpenCode können selbst aktualisieren. Bestehende Installationen werden nicht ersetzt. Die isolierten Konten behalten ihre eigenen Anmeldedaten. Jeweils eine Installation läuft gleichzeitig, mit maximal 15 Minuten Laufzeit. Unterstützt: macOS/Linux auf ARM64 und x64. Installation und Anmeldung sind getrennte Schritte. Details und npm-Fallback: [Native Installer](docs/refactor/native-installers.md).

## GitHub CLI für Agenten

Unter **Deine Tools → GitHub CLI** lässt sich `gh` auf dem AgentPier-Rechner installieren. Es ist ein Hilfswerkzeug für Agenten und erhält kein eigenes Konto oder Chat-Terminal. Vorhandene Installationen werden erkannt. Für neue Installationen verwendet AgentPier die offiziellen Binärpakete von `cli/cli` für macOS/Linux und prüft deren SHA-256-Prüfsumme sowie `gh --version`. Die Dateien liegen im privaten AgentPier-Datenverzeichnis.

Jeder GitHub-Token ist einem HTTPS-Host zugeordnet. Ohne Host-Port funktioniert dies auch für GitHub Enterprise. GitHub-Zugänge mit einem eigenen Port bleiben für den Repository-Clone verwendbar, werden aber nicht an `gh` übertragen. In neuen Coding-CLI-Sitzungen können Agenten beispielsweise `gh pr list` im Projekt oder `gh api --hostname firma.ghe.com user` verwenden. Die Anmeldung wird anhand des Repository-Hosts beziehungsweise des ausdrücklich gewählten Hosts bestimmt.

AgentPier setzt weder einen hostübergreifenden `GH_TOKEN` noch eine globale Git-Konfiguration. Shell- und Login-Sitzungen bekommen diese Agent-Zugangsdaten nicht. Bereits laufende Sitzungen ohne diese Integration müssen neu gestartet werden, damit sie die zusätzliche Umgebung erhalten. Details stehen in [GitHub-Zugänge für Agenten](docs/github-agents.md).

## AgentPier aus Coding-CLIs steuern

Unter **Einstellungen → MCP & Zugriffe** stehen die passende MCP-Adresse und kopierbare Anleitungen für Codex, Claude Code und OpenCode. Lokal funktioniert die Verbindung über Loopback-HTTP, vom anderen Rechner über das konfigurierte Tailscale-HTTPS. Die Browserfreigabe bestimmt Projekte, Konten, Provider und erlaubte Aktionen; sie lässt sich dort jederzeit widerrufen.

Agenten können damit Pipeline-Profile und Abläufe verwalten, Läufe starten und deren Fortschritt, Artefakte und Ergebnisse lesen. Pro Profil lassen sich CLI, Quellkonto, zentraler Provider und Modell wählen. Menschliche Freigaben bleiben in AgentPier. Details und Einrichtung stehen in [MCP-Zugriff](docs/mcp.md).

## MCP und Skills verwalten

Unter **MCP & Skills** zunächst die CLI wählen. Die Ansicht zeigt deren gemeinsame MCP-Konfiguration und bekannte Skill-Ordner einschließlich Pfad und Geltungsbereich. Projekt- und Plugin-Erweiterungen können zusätzlich vorhanden sein.

- **MCP:** Lokale Server mit Befehl, Argumenten und Umgebungsvariablen oder HTTP-Server mit URL und Headern hinzufügen. Vorhandene Konfiguration bleibt erhalten; geheime Werte werden in der Übersicht ausgeblendet. Änderungen gelten beim nächsten CLI-Start. OAuth-Anmeldungen erfolgen weiterhin im nativen CLI. Doppelte OpenCode-Definitionen in mehreren Konfigurationsdateien müssen dort aufgelöst werden, bevor sie hier entfernt werden können.
- **Skills:** Eine `SKILL.md` oder eine ZIP mit `SKILL.md` und Begleitdateien hochladen oder in das Dateifeld ziehen. Alternativ einen öffentlichen GitHub-Repository-, Unterordner- oder Archiv-Link eingeben. Pro Paket wird ein Skill installiert; bei Skill-Sammlungen den konkreten Unterordner wählen. Ein gültiger Name und eine Beschreibung im YAML-Frontmatter sind erforderlich.
- **Umfang:** Maximal 10 MiB ZIP, 20 MiB entpackt und 1.000 Archiveinträge. Bestehende Zielordner werden nicht überschrieben. Archivpfade und Symlinks werden geprüft; Installationsskripte werden nicht ausgeführt. Ausführbare Begleitdateien behalten das Ausführungsrecht für den Benutzer. Nur von AgentPier installierte und unverändert zugeordnete Skill-Ordner lassen sich hier entfernen.

Neue Skills liegen pro CLI im gemeinsamen nativen Ordner: `~/.codex/skills`, `~/.claude/skills` oder `~/.config/opencode/skills`. Bereits vorhandene Codex-Skills unter `~/.agents/skills` bleiben sichtbar. Zugangsdaten, Provider, Hauptmodell und Verlauf werden nicht zwischen Konten kopiert. Bestehende Erweiterungen werden beim nächsten Start oder über **Vorhandene Kontokonfigurationen übernehmen** zusammengeführt. Details zu Konflikten und Sicherungen: [Gemeinsame Erweiterungen](docs/shared-cli-extensions.md). Die Bestandsanzeige umfasst bekannte Quellen, begrenzt auf 1.000 Skill-Funde und vier Unterordner-Ebenen. Skills lassen sich nach Name, Beschreibung und Geltungsbereich durchsuchen und werden mit 20 Einträgen pro Seite angezeigt. Vorhandene Skills mit abweichenden Metadaten bleiben sichtbar und erhalten einen Hinweis.

## Plugins und Marketplaces verwalten

Unter **Plugins & Marketplace** die CLI wählen. Die Übersicht liest die nativen Plugin-Listen und Konfigurationen. Installierte Plugins und der Marketplace-Katalog zeigen jeweils 20 Einträge pro Seite; die Suche berücksichtigt alle Einträge. Marketplace-Quellen lassen sich als `owner/repo` oder HTTPS-URL hinzufügen; der Katalog bietet Namenssuche, Quellenfilter und Installation. Die Aktionen laufen auf dem AgentPier-Server im gemeinsamen nativen Benutzerprofil der CLI. Neue Sitzungen übernehmen Änderungen.

| CLI         | Verwaltung                                                                                                                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | Marketplaces hinzufügen, aktualisieren und entfernen; Plugins entdecken, installieren und entfernen. Einzelne Plugins nativ über `/plugins` aktivieren.                                                                             |
| Claude Code | Zusätzlich Plugins aktivieren, deaktivieren und aktualisieren. Aktionen verwenden ausdrücklich den Benutzer-Geltungsbereich des gewählten Profils.                                                                                  |
| OpenCode    | npm-Pakete mit optionaler Version über den nativen Plugin-Befehl hinzufügen und aus der globalen Konfiguration entfernen. OpenCode verwendet keine verwalteten Marketplaces. Server- und TUI-Plugin-Konfiguration werden angezeigt. |

Projektbezogene, automatisch erkannte und lokale Datei-Plugins sind gegebenenfalls schreibgeschützt. Entfernen verlangt eine Bestätigung in der Oberfläche. **Claude entfernt beim Löschen eines Marketplaces auch die zugehörigen Plugins**; bei einzelner Plugin-Deinstallation bleiben dessen Daten erhalten. Plugin-Code und Hooks stammen vom jeweiligen Anbieter. Fehlende oder ältere CLIs zeigen einen Hinweis, wenn ihre native Verwaltung nicht unterstützt wird. Eine laufende Aktion sperrt weitere Plugin-Änderungen derselben CLI; Listen und Befehle haben Ausgabe- und Zeitlimits.

## Agency Agents

Unter **MCP & Skills → Agency Agents** lässt sich der öffentliche Katalog von [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) durchsuchen, nach Kategorie filtern und seitenweise ansehen. Die Vorschau zeigt die Anweisungen und den festgelegten Git-Stand. Einzelne ausgewählte Agenten werden im nativen Format für Claude, Codex oder OpenCode installiert und gelten für alle Konten dieser CLI. Sie übernehmen das Sitzungsmodell und die vorhandenen Berechtigungen. AgentPier führt keine Installationsskripte aus diesem Repository aus. Extern bearbeitete Agentendateien werden beim Entfernen erhalten. [Details](docs/shared-cli-extensions.md#agency-agents).

## AgentBus

AgentBus ist nativ enthalten und bei neuen Coding-CLI-Sitzungen standardmäßig aktiviert. Sitzungen im selben realen Projektordner können einander entdecken, Nachrichten senden und ihre Inbox lesen. Beim Start lässt sich AgentBus abwählen. Shell- und Login-Sitzungen verwenden es nicht. Bestehende Sitzungen werden nicht nachträglich verändert.

Unter **AgentBus → Status** siehst du verbundene Sitzungen und wartende Nachrichten. **Nachrichten** zeigt Absender, Empfänger, Zeitpunkt, Text und Inbox-Status mit 20 Einträgen pro Seite. Diese Ansicht konsumiert keine Nachrichten und löst keine Modellarbeit aus. Die CLIs selbst können beim Nachrichtenaustausch weitere Modellarbeit auslösen. Codex kann eine native Prüfung neuer Hooks verlangen; die Statusansicht weist darauf hin.

Die Integration verwendet temporäre Konfiguration pro Sitzung und verändert keine globalen CLI-Konfigurationsdateien. Details zum enthaltenen Quellcode, den behobenen Fehlern und den Grenzen stehen in [AgentBus-Integration](docs/agentbus-integration.md).

## Pipelines und Aufgabenprofile

Unter **Pipelines** lassen sich Aufgaben durch wiederverwendbare CLI-Profile ausführen: Implementierung, Review, automatische Prüfungen und menschliche Freigaben. Profile verwenden vorhandene Konten und deren Provider; jeder Lauf bekommt einen eigenen Git-Worktree. Begrenzte Review-Schleifen, Rückmeldungen, Wiederholungen, Artefakte, Diffs und eine optionale PR-Erstellung gehören dazu. Die Stufen verlinken ihre normalen Chat- und Terminalansichten. Abbrechen erhält das Arbeitsverzeichnis; Aufräumen ist eine eigene Aktion. Details: [Pipelines](docs/pipelines.md).

## Rückfragen, Benachrichtigungen und Betrieb

Neue Codex-, Claude-Code- und OpenCode-Sitzungen zeigen unterstützte native Freigaben und Rückfragen direkt im Chat, einschließlich mehrerer Fragen und Mehrfachauswahl. Antworten gehen an die tatsächliche native Anfrage. Eine bereits im Terminal beantwortete Frage lässt sich nicht nochmals bestätigen. Bei unklarem Übertragungsstatus bleibt das Terminal erreichbar. Details und geprüfte CLI-Versionen: [Native Rückfragen](docs/research/native-requests.md).

Unter **Einstellungen** findest du zusätzliche Bereiche mit eigenen URLs:

- **Benachrichtigungen:** AgentPier als Web-App verwenden und Push pro Gerät ausdrücklich aktivieren. Generische Hinweise melden Rückfragen, fertige Antworten und Pipeline-Freigaben auch bei geschlossenem Browser. Nachrichtentext und Zugangsdaten stehen nicht im Push. Die Offline-Seite enthält keine gespeicherten Chats.
- **Diagnose:** Laufzeit, Werkzeuge, Datenbanken, Projekte und Einrichtung prüfen, mit Hinweisen zur Behebung.
- **Sicherungen:** Sicherung planen und herunterladen, verwaltete Zugangsdaten optional verschlüsseln, Archive prüfen und in ein neues Datenverzeichnis wiederherstellen. Repository-Ordner werden separat übertragen und zugeordnet. Importierte Sitzungen und Pipelines bleiben Historie.
- **Updates:** In einer versionierten Installation neue Releases prüfen, vorbereiten, aktivieren und zu kompatiblen früheren Versionen zurückkehren. Die Prüfung nach dem Neustart bestätigt die tatsächliche Version; native Sitzungen behalten ihre alten Hilfsprogramme.
- **Aktivitätsprotokoll:** Dauerhafte Ereignisse nach Aktion, Ergebnis, Sitzung und Projekt filtern. Keine rohen Chat-Inhalte oder Schlüssel werden als Ereignisdetails gespeichert.

[Backup, Restore, Installer und Release-Betrieb](docs/research/operations-portability.md) beschreiben die Formate und Befehle. [Privater Fernzugriff](docs/remote-access.md) erklärt Tailscale sowie eine separate AgentPier-Identität auf bereits verbundenen Rechnern. Push auf einem iPhone benötigt eine unterstützte installierte Home-Screen-Web-App und die Gerätefreigabe.

## Daten und Dauerhaftigkeit

Standardmäßig liegen alle AgentPier-Daten in `.data/`, außerhalb von Git. Ordner haben Modus 0700, private Dateien 0600. Keys und Tokens liegen in privaten lokalen Dateien, nicht verschlüsselt in einer externen Cloud.

- `accounts.json`, `profiles/`: native CLI-Profile und getrennte Provider-Sitzungsprofile
- `provider-connections.json`, `provider-connection-secrets/`: zentrale Provider-Verbindungen und einmal gespeicherte API-Keys
- `repositories.json`, `repository-secrets/`: Git-Zugänge, lokale Projekte und Tokens
- `sessions/`: Session-Metadaten, tmux-Konfiguration und gespeicherte Terminalansichten
- `chat/`: genaue Verlaufsverknüpfungen und letzte Chat-Snapshots
- `pipelines/`, `pipeline-runs/`, `pipeline-workspaces/`: versionierte Aufgabenprofile, Definitionen, Prüfkonfiguration und dauerhafte Ausführungsprotokolle
- `clis/`, `tool-installations.json`: verwaltete CLI-Binaries und Installationsstatus
- `preferences.json`: Standardarbeitsverzeichnis
- `native-sessions/`: technische Zuordnung zur tatsächlich laufenden nativen Unterhaltung
- `agentbus/`: projektbezogene AgentBus-Registrierung, Inbox und Nachrichtenarchiv
- `github-sessions/`: private GitHub-CLI-Konfiguration und ausgewählte Zugänge pro Agent-Sitzung
- `audit/`: dauerhafte, gefilterte Betriebsereignisse
- `notifications/`: private Geräteabonnements, VAPID-Schlüssel und Zustellzustände
- `requests/`: private kurzlebige Kanäle für native Rückfragen
- `operations/`, `imported-history/`: Sicherungen, Aufträge, Release-Belege und importierte AgentBus-Historie
- `config.json`: Port und optionaler privater Fernzugriff

Sitzungen überstehen Browser-Abbruch, Tab-Wechsel und Neustart des Webdienstes. Ein Betriebssystem-Neustart beendet Prozesse; vorhandene Einträge werden als gestoppt erkannt, niemals automatisch erneut ausgeführt. Der Rechner muss für Fernzugriff eingeschaltet, wach und mit Tailscale verbunden sein.

Konfiguration: `AGENTPIER_DATA_DIR`, `AGENTPIER_PORT` (Standard 4380), `AGENTPIER_DEV=1`. Die bisherigen `TUIUI_*`-Variablen und internen tmux-Namen bleiben für vorhandene Daten kompatibel.

## Entwicklung und Prüfung

```sh
AGENTPIER_DEV=1 npm start
npm run dev
npm test
npm run build
TUIUI_TEST_URL=http://127.0.0.1:4380 npm run test:e2e
```

Die Browser-Tests erwarten einen laufenden Webdienst mit aktuellem Build. Sie verwenden kontrollierte API-Antworten bzw. eigene temporäre HTTP-/tmux-Instanzen. Backend-Tests prüfen unter anderem Profil-/Token-Isolation, echten authentifizierten HTTPS-Git-Clone, Shutdown-Cleanup, Unicode ohne Service-Locale, Chat-/Aufgabenformate, Verlaufsbindung und die installierte Codex-History-API ohne Modellauftrag. Native Modellwechsel wurden zusätzlich mit Codex 0.153.4, Claude Code 2.1.263 und OpenCode 1.18.29 in isolierten Testprofilen ohne Modellanfrage geprüft.

## Technische Referenzen

- [Claude-Sitzungen und Transkripte](https://code.claude.com/docs/en/sessions)
- [Codex App-Server: lesende History-API](https://learn.chatgpt.com/docs/app-server)
- [OpenCode CLI](https://opencode.ai/docs/cli/) und [Server-/Aufgabenmodell](https://opencode.ai/docs/server/)
- [Claude-Modellauswahl](https://code.claude.com/docs/en/model-config) und [Tastenkürzel](https://code.claude.com/docs/en/interactive-mode)
- [Codex-Befehle und Startoptionen](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [OpenCode-Modellauswahl](https://opencode.ai/docs/tui/) und [Auto-Modus](https://opencode.ai/docs/permissions/#auto-mode)
- [GitHub: zugängliche Repositories auflisten](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user)
- [tmux: UTF-8-Verhalten](https://man.openbsd.org/tmux)
- [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)

- [Codex-Plugin-Befehle](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/cli/src/plugin_cmd.rs) und [Marketplace-Befehle](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/cli/src/marketplace_cmd.rs)
- [Claude-Plugin-Verwaltung](https://code.claude.com/docs/en/discover-plugins)
- [OpenCode-Plugin-Installation](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/cli/cmd/plug.ts) und [Konfigurationsziele](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/plugin/install.ts)
- CLI-Installationswege: [Codex](https://github.com/openai/codex), [Claude Code mit npm](https://code.claude.com/docs/en/setup#install-with-npm), [OpenCode](https://opencode.ai/docs/)

## Development

The codebase uses feature boundaries with a 600-line source/test limit. See [architecture](docs/architecture.md), [test strategies and reproducible commands](docs/testing.md), and the [full refactor contract](docs/refactor/design.md). Run `npm run check` and `npm run test:e2e` before submitting changes.

## Konten und Projektdateien

Auf der Kontenseite kann je CLI ein **Standardkonto** festgelegt werden. Neue native Sitzungen wählen es vor; eine ausdrücklich andere Auswahl gilt nur für diese Sitzung. Claude-Zugänge bleiben auf Claude beschränkt, Codex-Zugänge auf Codex. **Anmelden** öffnet bei Claude die normale TUI im gewählten Kontoprofil; ein bestätigter nativer Anmeldestatus wird als **Angemeldet** angezeigt.

Der Sitzungstab **Dateien** zeigt Projektordner, bis zu 100 Einträge pro Seite und Vorschauen für UTF-8-Text (256 KB) sowie PNG/JPEG/GIF/WebP (5 MB). Neue Ordner können angelegt werden. Pfad, Seite und ausgewählte Datei bleiben beim Reload erhalten. Der Explorer ist auf den Projektordner begrenzt; Verknüpfungen werden nicht aufgelistet, `.git` wird ausgeblendet. Dateiinhalte werden nicht verändert.
