# AgentPier auf einem Mac mini einrichten

Für Linux siehe [Linux-Installation](linux.md). Diese Anleitung ist für die spätere Installation auf dem Zielrechner. Lokales Testen mit `npm start` richtet keinen Autostart ein.

Beim ersten Öffnen einen Benutzer erstellen; anschließend mit Benutzername und Passwort anmelden. Das funktioniert auch über den freigegebenen Fernzugriff. Details zu Sitzungen und Wiederherstellung stehen unter [Anmeldung](login.md).

## Versioniertes Release installieren

Coding-CLIs lassen sich unabhängig von AgentPier-Releases unter **Deine Tools → CLI aktualisieren** aktualisieren. Details und manuelle Befehle stehen unter [CLI-Updates](cli-updates.md).

Die folgenden Abschnitte beschreiben den Start aus einem Source-Checkout. Für eine versionierte Installation mit unveränderlichen Releases, eigenem Node-Runtime und getrenntem Datenverzeichnis nutze stattdessen den [Release-Installer mit den genauen Befehlen](research/operations-portability.md#installer-and-exact-commands). Lade dafür das zur Plattform passende `.aprelease`-Paket aus den [offiziellen GitHub-Releases](https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases) herunter: `darwin` für macOS oder `linux`, jeweils mit `arm64` oder `x64` passend zum Rechner.

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

## 4. Optional: dauerhafter macOS-Dienst

Nur auf dem gewünschten Zielrechner und nach dem lokalen Test:

```sh
npm run service:install
npm run service:status
```

Die Installation schreibt ausschließlich den AgentPier-LaunchAgent `~/Library/LaunchAgents/dev.agentpier.server.plist`. Er startet den Webdienst beim Benutzer-Login und nach einem Absturz neu. Der Dienst läuft mit diesem Benutzerkonto; es ist kein Systemdienst vor der Anmeldung.

Die Plist speichert Node-Pfad, Projekt-/Datenverzeichnis und PATH zum Installationszeitpunkt. Nach Verschieben des Projekts oder einem Node-Upgrade `npm run service:install` erneut ausführen. Eigene CLI-Sitzungen bleiben beim Neustart des Webdienstes erhalten.

## 5. Optional: privater Fernzugriff über Tailscale

Bei laufendem und angemeldetem Tailscale auf dem Mac mini:

```sh
npm run tailscale
npm run service:install
```

Der zweite Befehl lädt die neu gespeicherte Remote-Konfiguration. Das Skript gibt eine private HTTPS-URL aus und wählt einen freien Port aus 8443, 10000 oder 9443. Bereits vorhandene andere Serve-Freigaben bleiben erhalten. Die URL erscheint auch in AgentPier.

Öffne diese URL auf deinem mit Tailscale verbundenen Handy. AgentPier akzeptiert Remote-Zugriff nur für das bei der Einrichtung ermittelte eigene Tailscale-Konto. Es richtet keinen öffentlichen Funnel ein.

Der Mac mini muss eingeschaltet und wach bleiben. Wähle dafür passende Energieeinstellungen am Zielrechner; AgentPier ändert sie nicht automatisch. Nach einem macOS-Neustart sind alte CLI-Prozesse beendet und müssen bewusst neu gestartet werden.

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

Die aktive Version, vorbereitete neuere Versionen und Versionen mit laufenden Prozessen bleiben erhalten. Für noch verwendete Versionen müssen zunächst die betreffenden Sitzungen neu geladen oder beendet werden. Kann die bestehende Prozessprüfung über `ps` nicht zuverlässig ausgeführt werden, wird nichts gelöscht. Während einer Aktivierung oder eines Rollbacks ist das Aufräumen gesperrt. Die Funktion verändert weder Sitzungsdaten noch Profile.
