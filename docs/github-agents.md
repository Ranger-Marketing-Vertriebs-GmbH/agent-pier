# GitHub-Zugänge für Agenten

Unter **Repositories → GitHub-Profile** wird jeder Token mit seinem HTTPS-Host gespeichert. Beispiele sind `github.com`, `firma.ghe.com` und ein eigener GitHub-Enterprise-Host. Mehrere Profile dürfen denselben Host verwenden. Pro Host ist genau ein Profil als **Standard für Agenten** markiert; das erste Profil übernimmt diese Rolle automatisch.

## Auswahl beim Sitzungsstart

Neue Codex-, Claude-Code- und OpenCode-Arbeitssitzungen bekommen die Standardzugänge aller unterstützten Hosts. Liegt das Arbeitsverzeichnis in einem mit AgentPier geklonten Projekt, hat dessen beim Klonen gewählter Zugang für den ursprünglichen Repository-Host Vorrang. Bei verschachtelten Projekten gilt das nächstgelegene Projekt. Ein inzwischen auf einen anderen Host verschobenes Token-Profil überschreibt keine fremde Host-Zuordnung.

Die Auswahl der Profil-IDs bleibt für die Sitzung gespeichert. Ein geänderter Standard gilt für neue Sitzungen; Token-Wechsel und Löschungen aktualisieren dagegen auch die bereits erzeugten Sitzungskonfigurationen. Ein gelöschter oder auf einen anderen Host verschobener Zugang wird dort deaktiviert. AgentPier setzt für diesen bisherigen Host einen festen ungültigen Platzhalter, damit `gh` nicht unbemerkt auf eine andere Anmeldung aus dem Betriebssystem-Schlüsselbund zurückfällt. Der Git-Credential-Helper gibt für deaktivierte Zugänge nichts aus.

Shell- und Login-Sitzungen erhalten diese Zugangsdaten nicht. Sitzungen, die bereits vor dieser Funktion gestartet wurden, erhalten keine nachträgliche Umgebungsänderung; für sie eine neue Sitzung starten.

## Verwendung

Im Projekt kann der Agent beispielsweise Folgendes verwenden:

```sh
gh pr list
gh issue list
git fetch
```

Für einen ausdrücklich gewählten Enterprise-Host:

```sh
gh api --hostname firma.ghe.com user
gh repo view firma.ghe.com/team/projekt
```

Die tatsächlich möglichen Aktionen hängen von den Berechtigungen des gespeicherten Tokens ab. AgentPier erweitert dessen Rechte nicht. Es verwendet keine gemeinsamen `GH_TOKEN`-/`GH_ENTERPRISE_TOKEN`-Variablen, die verschiedene Host-Zugänge überlagern könnten. Ein erzwungener `GH_HOST` oder `GH_REPO` wird ebenfalls nicht gesetzt. Git erhält einen eigenen Helper ausschließlich für die konfigurierten HTTPS-Hosts; die globale Git-Konfiguration bleibt erhalten.

## Private Dateien

Die generierten Dateien liegen unter `github-sessions/<AgentPier-Sitzungs-ID>/` im Datenverzeichnis:

- `config.yml`: natives Schema mit `version: 1`, damit `gh` keinen alten Konfigurationsstand migriert und dafür zusätzliche Benutzerabfragen benötigt.
- `hosts.yml`: Host-Zuordnung und Token; JSON-kompatibles YAML, Modus 0600.
- `selection.json`: ausgewählte Profil-IDs und Hosts, ohne Tokens.

Die Ordner sind 0700. Tokens erscheinen nicht in Prozessargumenten, Sitzungsmetadaten oder API-Antworten. Beim Entfernen einer Sitzung werden ihre generierten Dateien entfernt. Ein Webdienst-Neustart erhält die Zuordnung und gleicht die gespeicherten Tokens erneut ab. Der eigene Git-Helper liest nur diese Dateien und schreibt nicht in einen Credential-Manager.

`GH_CONFIG_DIR` trennt die Konfigurationsdateien. Es ist keine Betriebssystem-Isolation: Programme desselben Benutzers haben weiterhin dessen Dateirechte, und native `gh`-Aufrufe für völlig andere, nicht konfigurierte Hosts können weiterhin eine vorhandene Schlüsselbund-Anmeldung verwenden.

GitHub CLI unterstützt hier Hosts ohne eigenen Port. API-Aliase von `github.com` oder `ghe.com` werden nicht als unabhängige Hosts übertragen, weil `gh` diese normalisiert. Solche bestehenden Profile bleiben für den direkten HTTPS-Clone verfügbar.

## Installation und Prüfung

Unter **Deine Tools → GitHub CLI** lässt sich das offizielle `cli/cli`-Release für macOS oder Linux auf x64/ARM64 installieren. AgentPier prüft die Release-Prüfsumme, begrenzt Download und entpackte Größe und übernimmt ausschließlich Binary und Lizenz. Anschließend folgen eine Versionsprüfung und atomare Aktivierung im privaten `clis/gh/`-Verzeichnis. Vorhandene Installationen haben Vorrang; npm und sudo werden für `gh` nicht benötigt.

Installer-Tests verwenden temporäre Release-Archive. Credential-Tests prüfen Host-/Projektauswahl, Rotation und Entfernung, Dateirechte und Symlinks. Zusätzlich prüfen echtes `gh auth token` und `git credential fill` die erzeugte Konfiguration mit isoliertem HOME, Testtokens und blockiertem Netzwerk; es werden keine echten GitHub-Zugänge angesprochen.

Quellen: [GitHub-CLI-Umgebung](https://cli.github.com/manual/gh_help_environment), [GitHub-CLI-Anmeldung](https://cli.github.com/manual/gh_auth_login), [Git-Credential-Protokoll](https://git-scm.com/docs/gitcredentials), [offizielle Release-Konfiguration](https://github.com/cli/cli/blob/trunk/.goreleaser.yml).
