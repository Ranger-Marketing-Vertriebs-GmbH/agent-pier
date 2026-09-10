# AgentPier unter Linux

AgentPier läuft als normaler Benutzer mit Node.js, tmux und Git. Für den Webdienst ist kein Desktop erforderlich. Ein systemd-Benutzerdienst ist optional; auf Systemen ohne systemd funktioniert der manuelle Start mit `npm start`.

Beim ersten Öffnen einen Benutzer erstellen; anschließend mit Benutzername und Passwort anmelden. Das funktioniert auch über den freigegebenen Fernzugriff. Details zu Sitzungen und Wiederherstellung stehen unter [Anmeldung](login.md).

## Versioniertes Release installieren

Die folgenden Abschnitte beschreiben den Start aus einem Source-Checkout. Für eine versionierte Installation mit unveränderlichen Releases, eigenem Node-Runtime und getrenntem Datenverzeichnis nutze stattdessen den [Release-Installer mit den genauen Befehlen](research/operations-portability.md#installer-and-exact-commands). Dafür wird ein zur Plattform passendes `.aprelease`-Artefakt benötigt; diese Anleitung behauptet keine bereits veröffentlichte oder auf dem Zielrechner geprüfte Version.

`sh scripts/install.sh` benötigt aus einem sauberen Checkout kein `npm ci`. Fehlende tmux-/Git-Pakete werden standardmäßig installiert; Node wird bei Bedarf vorübergehend geladen und ist im Release enthalten. Fehlende Download-Werkzeuge (`curl`, `tar`, SHA-256-Prüfung) werden ebenfalls bei Bedarf installiert. Auf macOS wird vorhandenes Homebrew verwendet, unter Linux apt; `sudo` kann im Terminal nach dem Passwort fragen. Homebrew selbst muss vorhanden sein. Auf anderen Linux-Distributionen die fehlenden Pakete mit dem dortigen Paketmanager installieren.

`--skip-dependencies` prüft Voraussetzungen, ohne Host-Pakete zu installieren. `--install-dependencies` bleibt als kompatible Option erhalten. `--service` richtet den Benutzer-Webdienst ein und wartet auf dessen Versions-Healthcheck; dabei werden auch die üblichen Homebrew- und Systempfade gespeichert. Das Datenverzeichnis darf nicht innerhalb eines Release-Ordners liegen.

Fehlende Voraussetzungen einer bestehenden Installation lassen sich aus dem aktuellen Checkout nachinstallieren, ohne Releases oder Sitzungsdaten zu ändern:

```sh
sh scripts/install.sh --dependencies-only
```

Danach den AgentPier-Webdienst neu starten. Falls `tmux -V` funktioniert, aber der Dienst weiterhin `spawn tmux ENOENT` meldet, die Dienstkonfiguration mit dem aktualisierten `scripts/service.mjs install` und denselben Installations-/Datenpfaden erneut erstellen. Einzelheiten zu Updates, Schema-Grenzen und Rollback stehen in derselben Anleitung.

## Voraussetzungen und erster Start

Benötigt werden Node.js ab 22.13 mit npm, tmux und Git. Für das native Terminal-Modul können Python 3, make und ein C++-Compiler erforderlich sein, falls npm für das System kein passendes vorkompiliertes Modul findet. Installiere diese Voraussetzungen mit den üblichen Werkzeugen deiner Distribution. Die direkte Installation der drei Coding-CLIs in AgentPier unterstützt Linux auf x64 und ARM64.

```sh
node --version
npm --version
tmux -V
git --version

git clone https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier.git
cd agent-pier
npm ci
npm run build
npm start
```

Auf dem Server `http://127.0.0.1:4380` öffnen. Der Webdienst lauscht nur auf Loopback. Ein lokaler SSH-Tunnel ist zum ersten Test ebenfalls möglich:

```sh
ssh -L 4380:127.0.0.1:4380 dein-benutzer@dein-server
```

Dann dieselbe Adresse im Browser des eigenen Rechners öffnen. Für dauerhaften privaten Fernzugriff kann Tailscale wie in der [Installationsanleitung](installation.md#5-optional-privater-fernzugriff-über-tailscale) eingerichtet werden; die Linux-Installation und Anmeldung von Tailscale erfolgt separat.

Die GitHub CLI `gh` lässt sich ebenfalls unter **Deine Tools** installieren; sie verwendet die gespeicherten [GitHub-Zugänge je Host](github-agents.md) in neuen Agent-Sitzungen.

Codex, Claude Code und OpenCode können dort über **CLI aktualisieren** unabhängig von AgentPier-Releases aktualisiert werden. Details zur Umstellung älterer npm-Installationen und den manuellen Befehlen stehen unter [CLI-Updates](cli-updates.md).

Eine **Shell**-Sitzung benötigt keine Coding-CLI. AgentPier verwendet eine ausführbare konfigurierte zsh, bash oder sh und fällt sonst in dieser Reihenfolge auf die vorhandenen Varianten unter `/bin` oder `/usr/bin` zurück. zsh muss deshalb nicht nachinstalliert werden. Shell-Sitzungen haben ausschließlich den Terminalmodus und verwenden weder AgentBus noch den Chat. AgentBus verbindet nur dafür aktivierte Coding-CLI-Sitzungen im selben Projekt.

## Private Daten

Standardmäßig liegen Sitzungen und Profile unter `.data/` im Projekt. Optional vor dem manuellen Start und vor der Dienstinstallation einen festen Speicherort wählen:

```sh
export AGENTPIER_DATA_DIR="$HOME/.local/share/agentpier"
```

Denselben Wert für alle Einrichtungsbefehle verwenden. Das Datenverzeichnis wird mit Modus 0700 angelegt; Dienstdatei und private Dateien erhalten 0600. Keine zwei Webdienste mit demselben Datenverzeichnis gleichzeitig starten. Zugangsdaten gehören in die AgentPier-Profile, nicht in die systemd-Unit.

## Optional: systemd-Benutzerdienst

Der Dienst benötigt einen erreichbaren systemd-User-Manager; für `Type=exec` wird systemd ab Version 240 vorausgesetzt. Die folgenden Befehle als derselbe normale Benutzer ausführen, dessen CLI-Profile verwendet werden sollen, ohne `sudo`:

```sh
# Einen zuvor manuell gestarteten Webdienst zuerst mit Ctrl+C beenden.
npm run service:install
npm run service:status
```

Die Installation schreibt `~/.config/systemd/user/dev.agentpier.server.service`, beziehungsweise den entsprechenden Pfad unter einem absoluten `XDG_CONFIG_HOME`. Sie lädt die Unit-Konfiguration neu, aktiviert den Autostart für diesen Benutzer und startet den Webdienst neu. Node-Pfad, Projektverzeichnis, Datenverzeichnis und PATH werden zum Installationszeitpunkt übernommen. Nach einem Umzug des Projekts oder einem Node-Upgrade erneut `npm run service:install` ausführen. Bei fehlendem User-Manager bleibt die Dienstdatei unverändert; `npm start` kann weiterhin verwendet werden.

Status und Protokoll lassen sich auch direkt anzeigen:

```sh
systemctl --user status --no-pager dev.agentpier.server.service
journalctl --user -u dev.agentpier.server.service -f
```

`KillMode=process` beendet beim Stoppen oder Neustarten der Unit nur den Webprozess. Das ist hier bewusst gewählt, damit der private tmux-Server und laufende Terminals weiterleben und wieder verbunden werden können. Die systemd-Dokumentation weist darauf hin, dass verbleibende Prozesse damit außerhalb des normalen Dienstlebenszyklus laufen. Sitzungen deshalb gezielt in AgentPier stoppen, wenn sie ebenfalls beendet werden sollen. Ein Rechnerneustart beendet weiterhin alle CLI-Prozesse. [systemd.kill](https://github.com/systemd/systemd/blob/main/man/systemd.kill.xml)

Auf einem Server ohne dauerhafte Anmeldung kann _Lingering_ erforderlich sein: Es hält den User-Manager nach dem Abmelden am Leben und startet ihn beim Booten. Ob das erlaubt ist, hängt von der Systemrichtlinie ab. AgentPier schaltet es nicht automatisch ein. Bei Bedarf bewusst für das eigene Benutzerkonto einrichten und prüfen:

```sh
loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger
```

Das ersetzt keine funktionierende systemd-Benutzerumgebung beim Installieren; bei einer fehlenden Verbindung zum User-Manager in einer regulären SSH-/Benutzersitzung arbeiten. [loginctl](https://www.freedesktop.org/software/systemd/man/252/loginctl.html)

## Aktualisieren, stoppen und entfernen

Nach dem Aktualisieren der Repository-Dateien:

```sh
npm ci
npm run build
npm test
npm run service:install
```

Nur den Webdienst stoppen:

```sh
npm run service:stop
```

Der Autostart bleibt dabei aktiviert. Für die vollständige Entfernung des Autostarts nach dem Stoppen:

```sh
systemctl --user disable dev.agentpier.server.service
rm "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/dev.agentpier.server.service"
systemctl --user daemon-reload
```

Die Daten und laufenden tmux-Sitzungen werden dadurch nicht gelöscht. Falls Lingering eigens für diesen Dienst aktiviert wurde, vor dem Abschalten prüfen, ob andere Benutzerdienste davon abhängen.

## Prüfung und Grenzen

Die Service-Tests prüfen die Linux-Unit, Pfade mit Leerzeichen, Anführungszeichen, Backslashes, Dollar- und Prozentzeichen, private Dateirechte, Konfliktvermeidung sowie Installieren, Status und Stoppen mit einem simulierten Befehlsausführer. Der macOS-LaunchAgent wird weiter geprüft. Diese Änderung wurde auf macOS getestet; ein echter Linux-/systemd-Dienst wurde dabei nicht installiert oder gestartet.

Die Unit verwendet für `ExecStart` den dokumentierten `:`-Präfix gegen Variablenexpansion. In `Environment` sind Dollarzeichen bereits literal; Prozentzeichen werden als systemd-Specifier gesondert maskiert. [systemd.service](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml), [systemd.exec](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)
