# AgentPier auf einem Mac mini einrichten

Für Linux siehe [Linux-Installation](linux.md). Diese Anleitung ist für die spätere Installation auf dem Zielrechner. Lokales Testen mit `npm start` richtet keinen Autostart ein.

Beim ersten Öffnen einen Benutzer erstellen; anschließend mit Benutzername und Passwort anmelden. Das funktioniert auch über den freigegebenen Fernzugriff. Details zu Sitzungen und Wiederherstellung stehen unter [Anmeldung](login.md).

## Ein-Befehl-Installation auf macOS

Die folgenden Befehle gelten ab einem Release, das `install-agentpier.sh` enthält.
Der Homebrew-Weg benötigt zusätzlich das veröffentlichte Tap mit einer geprüften
Formel. Solange diese Veröffentlichung fehlt, die bestehende Release-Installation
im nächsten Abschnitt verwenden. Die lokalen Änderungen allein stellen noch keinen
öffentlichen Installer bereit.

Auf einem nativen Apple-Silicon- oder Intel-Mac mit macOS 14 oder neuer:

```sh
(agentpier_tmp=$(mktemp -d) && trap 'rm -rf "$agentpier_tmp"' EXIT && curl --fail --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases/latest/download/install-agentpier.sh -o "$agentpier_tmp/install.sh" && /bin/sh "$agentpier_tmp/install.sh")
```

Das Skript lädt zunächst das versionsgebundene Installer-Paket und prüft dessen
SHA-256. Es richtet fehlende Voraussetzungen einschließlich Homebrew bei Bedarf
über dessen offiziellen Installer ein. Bestätigungen, Command Line Tools und ein
Administratorpasswort können erforderlich sein. Als normaler Benutzer ausführen,
nicht mit `sudo`; auf Apple Silicon ein natives Terminal ohne Rosetta verwenden.

Wenn Homebrew bereits installiert und das Tap veröffentlicht ist:

```sh
brew install ranger-marketing-vertriebs-gmbh/tap/agentpier-installer && agentpier-install
```

Beide Wege verwenden dieselbe Einrichtung. Standardmäßig liegen die Anwendung unter
`~/.local/share/agentpier-app` und private Daten unter
`~/Library/Application Support/AgentPier`. Der Login-Dienst startet AgentPier auf
`http://127.0.0.1:4380`; Erfolg wird erst nach dem Versions-Healthcheck gemeldet.
Benutzer und Anbieter-Accounts anschließend in der Oberfläche einrichten; Coding-CLIs
lassen sich dort installieren. Fernzugriff wird separat eingerichtet.

`agentpier-install --help` zeigt die Optionen. Mit `--no-service` nur die Anwendung
installieren; `--install-root` und `--data-dir` überschreiben die Standardpfade.
Die entsprechenden `AGENTPIER_INSTALL_ROOT`-/`AGENTPIER_DATA_DIR`-Umgebungsvariablen
werden ebenfalls berücksichtigt. Verwende absolute, normalisierte Pfade ohne `..`;
das Datenverzeichnis muss außerhalb des Anwendungsverzeichnisses liegen.
`--dependencies-only` repariert ausschließlich fehlende Voraussetzungen.

Nach einem Abbruch denselben Befehl erneut aufrufen. Eine passende bestehende
Einrichtung wird wiederaufgenommen; eine bereits aktualisierte AgentPier-Version
wird nicht zurückgesetzt. Bei einer fremden bestehenden Installation, abweichenden
Datenpfaden oder belegtem Port meldet der Installer einen Konflikt, statt die andere
Instanz zu überschreiben. Bestehende Source-Installationen werden nicht automatisch
übernommen. Wird ein Prozess genau beim Übernehmen der Installationssperre beendet,
kann `.setup-recovery.lock` zurückbleiben. In diesem Fall stoppt der Installer mit
einem Hinweis zur manuellen Prüfung. Die Sperre erst entfernen, nachdem sicher
kein Setup-Prozess mehr läuft; unbekannte Dateien werden nicht automatisch gelöscht.

**Anwendungsupdates bleiben unter Einstellungen → Updates.** `brew upgrade` oder
`brew uninstall agentpier-installer` betrifft nur das Installer-Paket. Die laufende
Anwendung, ihr Dienst und private Daten bleiben davon getrennt. Zum Stoppen des Dienstes einer Installation mit Standardpfad:

```sh
"$HOME/.local/share/agentpier-app/current/bin/node" "$HOME/.local/share/agentpier-app/current/scripts/service.mjs" stop
```

Zum Entfernen des Autostarts anschließend die Datei
`~/Library/LaunchAgents/dev.agentpier.server.plist` entfernen. Bei eigenen Pfaden den
Anwendungspfad im Befehl entsprechend anpassen. Anwendungsreleases und private Daten
bleiben bestehen; Daten nur ausdrücklich entfernen.
Die Versionsnummer der Brew-Formel bezeichnet den Installer, nicht zwingend die
aktuell laufende AgentPier-Version.

## Versioniertes Release installieren

Coding-CLIs lassen sich unabhängig von AgentPier-Releases unter **Deine Tools → CLI aktualisieren** aktualisieren. Details und manuelle Befehle stehen unter [CLI-Updates](cli-updates.md).

Die folgenden Abschnitte beschreiben den Start aus einem Source-Checkout. Für eine versionierte Installation mit unveränderlichen Releases, eigenem Node-Runtime und getrenntem Datenverzeichnis nutze stattdessen den [Release-Installer mit den genauen Befehlen](research/operations-portability.md#installer-and-exact-commands). Lade dafür das zur Plattform passende `.aprelease`-Paket aus den [offiziellen GitHub-Releases](https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases) herunter: `darwin` für macOS oder `linux`, jeweils mit `arm64` oder `x64` passend zum Rechner.

Der [Datei-Explorer](file-explorer.md) verwendet die Dateirechte des Benutzers, unter
dem der Webdienst läuft. Versionierte Pakete enthalten Koffi und das passende native
Modul; Installation und Updates prüfen diese Laufzeitbestandteile. Dafür ist keine
manuelle Systemerweiterung nötig. Strikte neue-Inode-Operationen und ZIP-Extraktion
werden auf macOS nur ausgeführt, wenn die native Prüfung das konkrete APFS-Ziel bestätigt.

`sh scripts/install.sh` benötigt aus einem sauberen Checkout kein `npm ci`. Fehlende tmux-/Git-Pakete werden standardmäßig installiert; Node wird bei Bedarf vorübergehend geladen und ist im Release enthalten. Fehlende Download-Werkzeuge (`curl`, `tar`, SHA-256-Prüfung) werden ebenfalls bei Bedarf installiert. Auf macOS wird Homebrew verwendet und bei Bedarf über den [offiziellen Installer](https://brew.sh) eingerichtet; unter Linux wird apt verwendet. Bestätigungen und Admin-Passwort können im Terminal eingegeben werden. Ohne Terminal läuft der Homebrew-Installer nichtinteraktiv und benötigt passende Administratorrechte. Auf anderen Linux-Distributionen die fehlenden Pakete mit dem dortigen Paketmanager installieren.

`--skip-dependencies` prüft Voraussetzungen, ohne Host-Pakete zu installieren. `--install-dependencies` bleibt als kompatible Option erhalten. `--service` richtet den Benutzer-Webdienst ein und wartet auf dessen Versions-Healthcheck; dabei werden auch die üblichen Homebrew- und Systempfade gespeichert. Das Datenverzeichnis darf nicht innerhalb eines Release-Ordners liegen.

Fehlende Voraussetzungen einer bestehenden Installation lassen sich aus dem aktuellen Checkout nachinstallieren, ohne Releases oder Sitzungsdaten zu ändern:

```sh
sh scripts/install.sh --dependencies-only
```

Danach den AgentPier-Webdienst neu starten. Falls `tmux -V` funktioniert, aber der Dienst weiterhin `spawn tmux ENOENT` meldet, die Dienstkonfiguration mit dem aktualisierten `scripts/service.mjs install` und denselben Installations-/Datenpfaden erneut erstellen. Einzelheiten zu Updates, Schema-Grenzen und Rollback stehen in derselben Anleitung.

## 1. Voraussetzungen auf dem Zielrechner

- macOS mit einem normalen Benutzerkonto, unter dem auch die CLI-Sitzungen laufen sollen.
- Node.js 22.13 oder neuer mit npm, tmux und Git.
- Codex, Claude Code und OpenCode können bereits vorhanden sein oder später unter **Deine Tools → CLI installieren** eingerichtet werden.
- Optional: Tailscale, auf Mac mini und Mobilgerät im eigenen Tailnet angemeldet.

Mit bereits eingerichtetem Homebrew können die Laufzeitwerkzeuge beispielsweise so installiert werden:

```sh
brew install node@22 tmux git
```

Sorge dafür, dass die Node- und CLI-Binaries im PATH liegen. AgentPier sucht CLIs zusätzlich in `~/.local/bin`, `~/.opencode/bin`, `/opt/homebrew/bin` und `/usr/local/bin`. Anschließend prüfen:

```sh
node --version
npm --version
tmux -V
git --version
```

## 2. Projekt bereitstellen und zunächst lokal testen

Repo auf den Mac mini klonen/kopieren und im Projektordner ausführen:

```sh
git clone https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier.git
cd agent-pier
npm ci
npm run build
npm start
```

Am Mac mini `http://127.0.0.1:4380` öffnen. Fehlende CLIs einschließlich der GitHub CLI `gh` bei Bedarf über **CLI installieren** einrichten. Die Installation erfolgt auf diesem Server im AgentPier-Datenverzeichnis und wird mit `--version` geprüft. Anschließend CLI-Accounts einrichten und eine Sitzung in einem Testprojekt öffnen. Für jeden zusätzlichen Account ein eigenes Profil anlegen. GitHub-/Enterprise-Tokens separat unter **Repositories** eintragen.

Mit `Ctrl+C` den Test-Webdienst beenden, bevor der dauerhafte Dienst eingerichtet wird. Laufende Terminal-Sitzungen bleiben in tmux erhalten.

## 3. Datenverzeichnis optional festlegen

Ohne Anpassung wird `.data/` im Projekt verwendet. Für einen separaten Ort vor den folgenden Einrichtungsbefehlen setzen:

```sh
export AGENTPIER_DATA_DIR="$HOME/Library/Application Support/AgentPier"
```

Verwende denselben Wert für Start, Dienstinstallation und Tailscale-Einrichtung. Bestehende Daten nicht zwischen mehreren laufenden Instanzen teilen. Ein anderes Datenverzeichnis startet einen getrennten Workspace.

Optionale Explorer-Grenzen stehen in `config.json` unter `files.limits`. AgentPier liest
und prüft sie beim Start; unbekannte Schlüssel sowie nichtpositive oder nicht sichere
Ganzzahlen verhindern den Start. Den Webdienst vor einer Änderung stoppen und danach neu
starten. Es gibt dafür keine einzelnen Umgebungsvariablen oder Einstellungsfelder. Werte,
Standardgrenzen und Aufbewahrungsfristen sind in der
[Datei-Explorer-Anleitung](file-explorer.md#limits-and-retention) aufgeführt.

## 4. Optional: dauerhafter macOS-Dienst

Nur auf dem gewünschten Zielrechner und nach dem lokalen Test:

```sh
npm run service:install
npm run service:status
```

Die Installation schreibt ausschließlich den AgentPier-LaunchAgent `~/Library/LaunchAgents/dev.agentpier.server.plist`. Er startet den Webdienst beim Benutzer-Login und nach einem Absturz neu. Der Dienst läuft mit diesem Benutzerkonto; es ist kein Systemdienst vor der Anmeldung.

Die Plist speichert Node-Pfad, Projekt-/Datenverzeichnis und PATH zum Installationszeitpunkt. Nach Verschieben des Projekts oder einem Node-Upgrade `npm run service:install` erneut ausführen. Eigene CLI-Sitzungen bleiben beim Neustart des Webdienstes erhalten.

## 5. Optional: privater Fernzugriff

Für den Zugriff von einem anderen Gerät gibt es zwei gleichwertige Wege: [Tailscale Serve](remote-access.md#weg-a-tailscale-serve) mit HTTPS im eigenen Tailnet, oder der [Netzwerkmodus ohne Tailscale](remote-access.md#weg-b-netzwerkmodus-ohne-tailscale), der sich auch headless mit `npm run remote` einschalten lässt und nur durch die Anmeldung geschützt ist. Beide Wege sind in der [Fernzugriffsanleitung](remote-access.md) mit den genauen Befehlen beschrieben; die eigene Tailscale-Freigabe wird beim Entfernen des Diensts weiter unten mit `tailscale serve --https=8443 off` deaktiviert.

## 6. Aktualisieren

Bei einer versionierten Installation unter **Einstellungen → Updates** nach einer neuen Version suchen, das Paket herunterladen und anschließend aktivieren. Bei einem angebotenen oder bereits vorbereiteten Update zeigt die App die GitHub-Release-Notes genau dieser Version an. Sie werden separat geladen; fehlen die Hinweise oder ist GitHub nicht erreichbar, bleibt das Update möglich. Eigene Update-Kanäle zeigen keine möglicherweise unpassenden Notes des offiziellen Releases. Standardmäßig kommen die Pakete aus den [offiziellen GitHub-Releases](https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases); ein eigener Kanal kann über `AGENTPIER_RELEASE_CHANNEL` gesetzt werden. Der Download wird per SHA-256 geprüft. Schlägt der Start der neuen Version fehl, wird die vorherige Version wieder aktiviert. CLI-Sitzungen bleiben beim Neustart des Webdienstes erhalten.

Bei einem Source-Checkout stattdessen nach Aktualisieren der Repository-Dateien:

```sh
npm ci
npm run build
npm test
npm run service:install
```

Daten in `.data/` bzw. im eigenen Datenverzeichnis bleiben erhalten. Vor Migrationen private Profildaten sichern. OAuth-/Keychain-Anmeldungen sind unter Umständen an den jeweiligen Mac gebunden; auf dem Mac mini erneut anmelden, statt Keychain-Dateien vom MacBook zu kopieren.

## Stoppen und entfernen

```sh
npm run service:stop
```

Das stoppt nur den Webdienst. Falls auch CLI-Sitzungen beendet werden sollen, diese vorher gezielt in der Oberfläche stoppen.

Für vollständiges Entfernen des Autostarts nach dem Stoppen:

```sh
rm "$HOME/Library/LaunchAgents/dev.agentpier.server.plist"
```

Die eigene Tailscale-Freigabe separat deaktivieren; den tatsächlich eingerichteten Port verwenden:

```sh
tailscale serve --https=8443 off
```

Kein `tailscale serve reset` verwenden, wenn andere Freigaben existieren. Projektordner und Profildaten nur entfernen, wenn sie nicht mehr benötigt werden. Alte Installationen unter dem früheren Namen verwenden gegebenenfalls `dev.tuiui.server.plist`; einen solchen Dienst vor dem Umstieg gezielt stoppen, damit nicht zwei Webdienste denselben Port verwenden.

### Alte Versionen entfernen

Unter **Einstellungen → Updates → Alte Versionen aufräumen** können ältere Versionen einzeln oder gesammelt gelöscht werden. Die Bestätigung nennt die konkrete Auswahl. Gelöschte Versionen stehen nicht mehr für einen Rollback bereit.

Die aktive Version, vorbereitete neuere Versionen und Versionen mit laufenden Prozessen bleiben erhalten. Kann die bestehende Prozessprüfung über `ps` nicht zuverlässig ausgeführt werden, wird nichts gelöscht. Während einer Aktivierung, eines Rollbacks oder eines Session-Umzugs ist das Aufräumen gesperrt. Die Funktion verändert weder Sitzungsdaten noch Profile.

#### Sessions umziehen

Eine Version mit laufenden Prozessen zeigt über **Sessions anzeigen** die AgentPier-Sessions, die sie halten, mit ihrem Zustand: bereit, beschäftigt, Zustand unbekannt, wird neu geladen oder nicht neu ladbar. **Sessions umziehen und Version löschen** lädt jede Session mit [Reload & resume](session-reload.md) auf die aktive Version neu und löscht die Version, sobald die letzte Session umgezogen ist. Beschäftigte Sessions ziehen erst nach Abschluss ihres aktuellen Schritts um; Sessions mit unbekanntem Zustand warten, bis das CLI erkennbar bereit ist. **Sofort umziehen und löschen** startet alle Sessions nach Bestätigung sofort neu und bricht laufende Arbeit ab. Ein laufender Umzug lässt sich abbrechen; bereits angestoßene Reloads laufen dann eigenständig weiter, die Version bleibt erhalten.

Sessions, die nicht neu geladen werden können (Pipeline-, Login-, Shell- oder unverifizierte Sessions), müssen manuell beendet werden. Prozesse außerhalb einer Session, etwa ein laufender Pipeline-Supervisor oder der Release-Helfer, blockieren den Umzug und werden mit ihrem Pfad genannt. Node-Prozesse, die nur das Node-Binary der Version nutzen, blockieren nicht; sie werden nach dem Umzug erneut geprüft. Verwenden nach dem Umzug weiterhin Prozesse die Version, bleibt sie erhalten und der Vorgang nennt die verbleibenden Verweise.

Beim Aktivieren einer vorbereiteten Version bietet die Bestätigung **Laufende Sessions danach auf die neue Version umziehen** an. Der Umzug beginnt erst, nachdem die neue Version ihre Zustandsprüfung bestanden hat, und unterbricht nichts. Schlägt die Aktivierung fehl oder wird sie zurückgerollt, findet kein Umzug statt.
