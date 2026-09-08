# Completed full-refactor verification (2026-09-07)

Before the final pipeline feature, the refactor, shared memory, providers and chat additions pass:

- `npm run check`: lint, formatting, 600-line source/test gate, 390 backend tests and production build.
- `FC_SEED=173205 FC_RUNS=300 npm run test:property`: 19 passing tests.
- Production browser suites: 114 Chromium and 114 WebKit tests, each against isolated temporary application data.
- Independent reviews of memory scope/lifetime, provider edits/context, native observations, lifecycle/transport extraction and pagination; confirmed findings fixed with regressions.
- Local test web restart and HTML/provider route checks; existing protected native processes preserved.

No global coding CLI/service was installed and no paid model calls were made. Provider configuration checks do not certify account entitlement or live inference; see [providers](providers.md). The [remote matrix](https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/actions/runs/34065818044) at `6a749cc` passes all six jobs: macOS/Linux with Node 22/24 and Chromium/WebKit. Backend CI has 389 passing tests and one optional installed-Codex check skipped; Ubuntu/Node 24 also passes ten repeated shell/memory exit runs. The final pipeline verification below completes the whole-goal checks.

## Final pipeline verification

The integrated pipeline/profile implementation passes local `npm run check`: 464 backend tests, lint, formatting, the 600-line gate and production build. The alternate generated suite passes 24 tests with seed `173205` and 300 runs. Full production browser suites pass 130/130 in Chromium and WebKit. The local server restart and HTML/API smoke checks pass with protected native sessions preserved. The [final six-job remote matrix](https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/actions/runs/34068255525) passes at `5b3ab20`, including all four Linux/macOS × Node 22/24 backend jobs and both browser jobs.

Independent reviews and failing-then-passing regressions cover conditional side effects, human-required results, native exit and malformed-event handling, durable repair/reconcile intents, per-attempt verification, immutable override checkpoints, bounded log metadata, stage artifact scope and PR refresh. The public HTTP lifecycle drives an isolated real tmux/synthetic CLI/Git worktree through verification, a human gate and web restart. Live paid inference and external PR publication are deliberately outside these automated checks.

The following is historical verification from earlier feature batches.

# AgentPier — Prüfstand 2026-09-06

Der aktuelle Stand läuft **nur als lokaler Test-Webdienst** auf `http://127.0.0.1:4380`. Der irrtümlich auf dem MacBook eingerichtete LaunchAgent `dev.tuiui.server` und seine einzelne Tailscale-Serve-Freigabe wurden entfernt. Kein AgentPier-Autostart wurde installiert. Die vorhandenen Claude- und Codex-Sitzungen wurden nicht bedient oder beendet. Die spätere Einrichtung ist für [Mac mini](installation.md) und [Linux](linux.md) dokumentiert.

## Ausgeführt

- `npm test`: **200/200** bestanden.
- `TUIUI_TEST_URL=http://127.0.0.1:4380 npm run test:e2e`: **87/87** bestanden.
- `npm run build`: erfolgreich; getrennte Terminal-Komponente, keine Warnung wegen zu großer Chunks.
- `git diff --check`: sauber.

## Wesentliche Nachweise

- Fehlende LANG-/LC_ALL-/LC_CTYPE-Werte reproduzierten exakt den Unicode-Verlust (`Änderungen` → `_nderungen`, Logo → Unterstriche). `tmux -u` korrigiert Erstverbindung und Reconnect.
- Echte temporäre PTYs prüfen Eingabe, mehrzeilige Nachrichten, Größenänderung, Reconnect, Webdienst-Neustart, Ctrl+C, gezieltes Stoppen und erhaltene Prozessdaten.
- Der Browser sendet Nachrichten über HTTP an einen echten temporären PTY-Prozess, dessen strukturierte Claude-JSONL-Fixture separat gerendert wird. Terminalstatus erscheint nicht im Chat. Diese Fixtures verwenden keine Modellaufrufe.
- Aufgabenstatus, Markdown, Tool-Details, exakte Verlaufswahl und mobile Standardansicht sind geprüft. Terminalwechsel erhält Nachrichtenentwurf, geöffnete Tool-Details und Leseposition; die mobile Chatansicht öffnet keinen versteckten PTY, der die native TUI verkleinern würde.
- Account-/Projektbindung, unvollständige JSONL-Zeilen, leere Startup-Dateien, ungültige Metadaten und Profil-Symlinks sind abgedeckt. Lange paginierte Codex-Verläufe behalten die neuesten Turns.
- Der tatsächlich installierte Codex-App-Server wurde mit isoliertem HOME/CODEX_HOME für reine History-Abfragen gestartet und beendet, ohne Modellauftrag.
- Ein echter lokaler HTTPS-Git-Server mit Token-Challenge und eigener Test-CA prüft erfolgreichen Clone, sauberen Remote, Token-/Origin-Isolation, Redirect-Verweigerung, bestehende Zielordner, parallele Kollisionen, Timeout und Shutdown-Cleanup.
- GitHub-/Enterprise-Profilverwaltung und Clone-Erfolg/-Fehler über Seitenwechsel sind im Browser geprüft. Der Session-Start übernimmt das geklonte Projektverzeichnis.
- Desktop Enter/Shift+Enter, IME und Touch-Eingabe bei 390 und 844 Pixeln sind geprüft. Touch sendet ausschließlich per Button.
- Native Startmodi werden serverseitig je Tool validiert. Login und Standardmodus erhalten keine zusätzlichen Freigabe-Flags; die Browserauswahl setzt den Modus bei einem Profilwechsel zurück.
- Native Modellmenüs wurden in eigenen temporären Profilen mit Codex 0.153.4, Claude Code 2.1.263 und OpenCode 1.18.29 bedient: Claude wechselt nur für die Testsitzung, Codex wählt Modell und Denkstufe, OpenCode sucht und wählt Modelle. Dabei wurden keine Modellanfragen gestartet. Die drei Test-Tmux-Server und ihre Profile wurden anschließend entfernt; die ursprüngliche Claude-Pane blieb am Leben.
- Modelltests prüfen verzögerte Menüs, veraltete Zustände, Provider-Beschreibungen, lange Suchtexte, unbekannte Bestätigungen und den Schutz vor als Chattext zitierten Auswahlmenüs. Nur erkannte Auswahlmenüs bekommen eine einzelne Bestätigung; kein automatisches Durchklicken weiterer Dialoge.
- Öffentliche GitHub-Clones benötigen kein Token. Organisations-/Repository-Suche, Enterprise-API-Pfad, Pagination, Limits und Abbruch sind geprüft. Enter in der Suche startet keinen zuvor ausgefüllten Clone.
- MCP-Änderungen und Skill-Installationen sind mit temporären Profilen geprüft: TOML/JSON/JSONC bleiben außerhalb der Änderung erhalten, geheime Werte werden nicht zurückgegeben. Doppelte OpenCode-Definitionen und doppelte JSON-Schlüssel werden nicht still verändert. Tests schützen gegen Symlink-Ausbrüche, ZIP-Traversal, Expansion und Überschreiben; ausführbare Skill-Dateien erhalten 0700. Download-Abbruch und ein Upload über der allgemeinen JSON-Grenze sind über echte HTTP-Routen geprüft.

- Der CLI-Installer ist mit temporären npm-Fixtures für alle drei Tools geprüft: fester Paketname, privater Präfix, Versionsprüfung, Fehler, Wiederholung und Shutdown. Ein echter npm-Aufruf prüft ausschließlich die isolierte Konfiguration, ohne Paketdownload. Ein npm-Wrapper mit `#!/usr/bin/env node` funktioniert auch mit minimalem Dienst-PATH.
- Plugin- und Marketplace-Verwaltung ist mit nativen JSON-Formaten, temporären Profilen und ausführbaren Fixtures geprüft. Erfasst sind Profilwahl, feste Argumente, schreibgeschützte Quellen, JSONC-Erhalt, Geheimnis-Redaktion, Symlink-Schutz, parallele Anfragen, Ausgabegrenzen, Timeout und Shutdown einschließlich Kindprozess, der SIGTERM ignoriert.
- Desktop-/Mobil-Browsertests prüfen Marketplace-Suche, Installation, Deaktivierung, sichtbare Entfernen-Bestätigung, Zurücksetzen gelöschter Filter, fehlgeschlagene Anfragen, doppelte Klicks sowie Wiederöffnen eines laufenden CLI-Installers.

- Native Terminalfarben sind mit ANSI-/True-Color-Fixtures geprüft. Die AgentPier-Oberfläche verwendet Anthrazit/Orange; SVG-Favicon und ICO-Fallback werden ausgeliefert.
- Mobile Composer-/Modellmenü-Geometrie ist bei 390×844 und 390×500 geprüft. Konto- und Startmoduslisten bleiben beim Scrollen und bei skalierter Darstellung am Feld verankert.
- Deep Links erhalten Sitzungsansicht, Erweiterungsprofil, AgentBus-Projekt und Nachrichtenseite über Reload und Browserhistorie. Ungültige und Shell-Profil-Links zeigen einen eindeutigen Zustand.
- Der Standardarbeitsordner wird über echte temporäre API-Instanzen gespeichert; explizite Projektwahl und Login-Verzeichnisse bleiben korrekt. Reine Shell-Sitzungen verwenden keine Kontoverwaltung, Modellsteuerung oder AgentBus. Echte temporäre zsh- und POSIX-sh-PTYs prüfen Unicode, Eingabe, Replay und Neustart.
- Lokale Chatbilder sind mit Signaturen, Größenlimits, Symlinks, manipulierten Pfaden und fremden Sitzungs-IDs geprüft; Browser-Tests prüfen Vergrößerung, fehlende Dateien und mobile Breite.
- AgentBus-Fixtures prüfen Projekt-/Profilzuordnung, native Adapter, Socket-Wecksignale, dauerhafte Nachrichten und Identitätsarchive nach Unregister. Die Nachrichtenansicht bleibt rein lesend. Sender-Zugangsdaten werden nicht an Codex-Empfänger vererbt.

- Die automatische Verlaufszuordnung ist mit parallelen Sitzungen im selben Projekt, Profilgrenzen, Prozessneustart, PID-Wiederverwendung, npm-Launchern und nativen Sitzungswechseln geprüft. Die bestehende Codex-Sitzung wurde zusätzlich über ihre offenen nativen Verlaufsdateien exakt zugeordnet; GET Chat liefert den zugehörigen Verlauf ohne Terminaleingabe.
- Linux-systemd-Rendering und Installations-/Status-/Stop-Abläufe sind mit simulierten Befehlen geprüft, einschließlich Sonderzeichen in Pfaden und Schutz bestehender Units. Der macOS-LaunchAgent-Pfad bleibt abgedeckt.

- Die GitHub CLI wird als Hilfswerkzeug ohne eigenes Konto/Sitzungsangebot erkannt. Installer-Tests prüfen offizielle macOS-/Linux-Release-Namen, SHA-256, Download-/Archivgrenzen, Links/Traversal, Version, Abbruch und parallele Zielordner. Es wurden nur Testarchive entpackt.
- Hostbezogene Agent-Zugänge sind mit mehreren Tokens je Host, Projektvorrang, verschachtelten Verzeichnissen, Token-Wechsel und Deaktivierung geprüft. Echtes `gh` und Git lesen ausschließlich Testtokens bei blockiertem Netzwerk; globale Konfigurationsdateien bleiben unverändert. Deaktivierte Hosts fallen nicht auf eine andere Schlüsselbund-Anmeldung zurück. Beschädigte Zuordnungsmetadaten deaktivieren die erzeugte Anmeldung und geben keine gespeicherten Tokens mehr aus.

- Die Navigation ist mit gespeicherten auf-/zugeklappten Gruppen, direkten Verwaltungslinks und einer dynamisch wechselnden Sitzungsaktivität geprüft. Beendete Prozesse und reine Shells behalten eigene Anzeigen.
- Native Aktivitäts-Fixtures prüfen Claude, Codex und OpenCode, erkennbare Eingabemenüs, zitierte Dialogtexte, veraltete Spinner, Lese-Cache und begrenzte parallele Terminalabfragen. Die API liefert nur den abgeleiteten Status. Beim lokalen Webdienst-Neustart blieben beide bestehenden CLI-Sitzungen erhalten; eine rein lesende Abfrage erkannte Claude als arbeitend und Codex als bereit.
- Aufgaben stehen auf Desktop links vom Chat; mobil öffnet ein modales Seitenpanel ohne Verlust an Nachrichtenhöhe. Escape stellt den Tastaturfokus wieder her, und Tab erreicht keine verdeckten Chat-Steuerelemente. Bei 390×844 bleiben 486 Pixel Nachrichtenhöhe, bei 390×500 noch 142 Pixel. Alte `/reader`-Links führen weiterhin zur neuen `/chat`-Adresse.

## Grenzen

Die Arbeitsanzeige hängt von erkennbaren nativen CLI-Statuszeilen ab; unbekannte Darstellungen und eingefrorene Spinner werden als unbekannt markiert. Die Chatansicht liest gespeicherte Provider-Nachrichten periodisch; native Freigaben bleiben im Terminal. Die Modellsteuerung ist an erkennbare native Menüs gebunden; eigene Tastenkürzel, andere CLI-Versionen oder zusätzliche Bestätigungen können die Terminalansicht erfordern. Codex-Aufgaben benötigen gespeicherte strukturierte Plan-Updates, nicht nur Plantext. GitHub-Suche betrachtet maximal 1.000 zugängliche Repositories. Die Erweiterungsübersicht zeigt bekannte Benutzer-/Profilquellen, nicht vollständig alle projekt- oder pluginabhängigen Erweiterungen. Codex-Skills sind gemäß seiner nativen Struktur im Benutzerordner geteilt. Keine neuen CLI- oder Plugin-Pakete auf dem MacBook installiert; echte Downloads und Installationsskripte der Anbieter wurden nicht ausgeführt. Kein echter Modelllauf, Mac-mini-Deployment oder neu eingerichteter Tailscale-Zugang wurde getestet. Die Tests liefen unter macOS; ein echter Linux-Rechner beziehungsweise systemd-Benutzerdienst stand nicht zur Verfügung.

## Ansichten

- [Chat mit Aufgaben auf Desktop](screenshots/agentpier-chat-desktop.png)
- [Mobile Chatansicht mit aufgeklappten Aufgaben](screenshots/agentpier-chat-mobile.png)
- [Kompakte Navigation mit Arbeitsstatus](screenshots/agentpier-sidebar-desktop.png)
- [Mobile Navigation](screenshots/agentpier-sidebar-mobile.png)
- [Mobiles Aufgabenpanel links](screenshots/agentpier-tasks-left-mobile.png)
- [Native TUI mit Unicode](screenshots/agentpier-unicode-terminal.png)
- [Modell-Dropdown](screenshots/agentpier-model-dropdown.png)
- [Plugins und Marketplace](screenshots/agentpier-plugins.png)
- [Mobile Plugin-Verwaltung](screenshots/agentpier-plugins-mobile.png)
- [Verankerte Kontoauswahl auf Mobilgeräten](screenshots/agentpier-launch-mobile.png)

- [GitHub-CLI-Installer](screenshots/agentpier-gh-installer.png)

## Pipeline views

- [Desktop builder](screenshots/agentpier-pipelines-builder-desktop.png)
- [Mobile builder](screenshots/agentpier-pipelines-builder-mobile.png)
- [Desktop run](screenshots/agentpier-pipelines-run-desktop.png)
- [Mobile run](screenshots/agentpier-pipelines-run-mobile.png)
- [Mobile profile editor](screenshots/agentpier-pipelines-profile-mobile.png)
