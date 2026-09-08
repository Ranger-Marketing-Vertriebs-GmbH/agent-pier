# AgentPier auf einem Mac mini einrichten

Für Linux siehe [Linux-Installation](linux.md). Diese Anleitung ist für die spätere Installation auf dem Zielrechner. Lokales Testen mit `npm start` richtet keinen Autostart ein.

Beim ersten Öffnen einen Benutzer erstellen; anschließend mit Benutzername und Passwort anmelden. Das funktioniert auch über den freigegebenen Fernzugriff. Details zu Sitzungen und Wiederherstellung stehen unter [Anmeldung](login.md).

## Versioniertes Release installieren

Die folgenden Abschnitte beschreiben den Start aus einem Source-Checkout. Für eine versionierte Installation mit unveränderlichen Releases, eigenem Node-Runtime und getrenntem Datenverzeichnis nutze stattdessen den [Release-Installer mit den genauen Befehlen](research/operations-portability.md#installer-and-exact-commands). Dafür wird ein zur Plattform passendes `.aprelease`-Artefakt benötigt; diese Anleitung behauptet keine bereits veröffentlichte oder auf dem Zielrechner geprüfte Version.

`sh scripts/install.sh` benötigt aus einem sauberen Checkout kein `npm ci`. `--install-dependencies` erlaubt ausdrücklich die Installation fehlender tmux-/Git-Pakete, `--service` richtet den Benutzer-Webdienst ein und wartet auf dessen Versions-Healthcheck. Auf macOS wird vorhandenes Homebrew verwendet; die automatische Linux-Installation unterstützt apt. Ohne diese Optionen werden Voraussetzungen geprüft und nur die Release-Dateien installiert. Das Datenverzeichnis darf nicht innerhalb eines Release-Ordners liegen. Einzelheiten zu Updates, Schema-Grenzen und Rollback stehen in derselben Anleitung.

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

Nach Aktualisieren der Repository-Dateien:

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
