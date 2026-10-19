# AgentPier

**Deine Coding-CLIs und persönlichen Agenten, auf deinem eigenen Rechner.**

Selbst gehosteter Arbeitsbereich für Coding-CLIs (Codex, Claude Code, OpenCode) und
dauerhafte persönliche Agenten. Native Terminals und Chat auf Desktop und Handy,
Pipelines mit Review und Agenten, die als Team arbeiten.

[English](README.md) · [Dokumentationsübersicht](docs/README.md) ·
[Mitwirken](CONTRIBUTING.md) · [Sicherheit](SECURITY.md) · [Lizenz](LICENSE)

Die Anleitungen unter `docs/` sind überwiegend auf Englisch.

![AgentPier mit einem Agenten-Chat, einem Teammitglied und Coding-Sessions in der Seitenleiste](docs/screenshots/agentpier-agent-chat-desktop.png)

<img src="docs/screenshots/agentpier-agent-chat-phone.png" alt="Derselbe Agenten-Chat auf einem Handy" width="260">

## Was du bekommst

- **Native CLI-Sessions:** echte tmux-Terminals mit Anmeldung, Modellen und
  Rückfragen der jeweiligen CLI, dazu eine Chat-Ansicht, die sich auf dem Handy
  wiederherstellt und Diktat annimmt ([Neu laden und fortsetzen](docs/session-reload.md),
  [Nachrichten auf dem Handy](docs/mobile-delivery.md),
  [Diktat](docs/assistant-gateway.md#live-dictation-in-the-chats)).
- **Eingang:** alle Fragen und Freigaben der CLIs, Pipeline-Gates und Anfragen deiner
  Agenten, die auf dich warten, mit Live-Zähler an einer Stelle beantwortet;
  Claude-Code-Freigaben bieten „Dauerhaft erlauben“ pro Account und zeigen Pläne vor
  der Freigabe ([Eingang](docs/inbox.md#claude-code-approvals-and-plans)).
- **Pipelines mit Review:** wiederverwendbare Profile, isolierte Git-Worktrees,
  begrenzte Review-Schleifen, Prüfungen und menschliche Freigabe
  ([Pipelines](docs/pipelines.md)).
- **Agenten und Teams:** dauerhafte Agenten, deren Leads ihre Mitglieder fragen und
  ihnen Aufgaben übergeben, auf Anfrage, als Vorschlag oder selbstständig, Agency-Agenten
  als Vorlagen für Agenten und Mitglieder, mit @-Erwähnungen, Telegram, Skills, Routinen, Check-ins,
  Dateien in beide Richtungen, über ChatGPT erstellte Bilder, Lese- oder Schreibzugriff auf Projektordner und GitHub
  über deine Tokenprofile ([Agenten](docs/agents.md)).
- **Zentrale MCP-Server:** einen Server einmal anlegen und an Agenten und deine
  Coding-CLIs binden, mit OAuth-Anmeldung aus AgentPier und eigenen Ordnern je Agent
  für lokale Server ([MCP](docs/mcp.md)).
- **Accounts an einer Stelle:** native CLI-Accounts, Provider-Zugänge, ChatGPT für
  Agenten und Dienste für Agenten ([Provider](docs/providers.md)).
- **Dateien und Wissen:** ein Datei-Explorer, private Artifacts, gemeinsames
  Projektwissen und AgentBus zwischen Sessions ([Dateien](docs/file-explorer.md),
  [Artifacts](docs/artifacts.md), [Projektwissen](docs/memory.md),
  [AgentBus](docs/agentbus-integration.md)).
- **Fürs Handy gemacht:** Installation als App, Push-Benachrichtigungen sowie
  Wiederherstellung von Zustellung und Uploads
  ([Benachrichtigungen](docs/notifications.md),
  [Wiederherstellung auf dem Handy](docs/mobile-recovery.md)).
- **Betrieb:** Sicherungen, Updates über die Kanäle Stable und Preview, ein
  Aktivitätsprotokoll und ein Systemstatus auf der Startseite mit Speicher, CPU und
  RAM, dem Anteil von AgentPier und einer Warnung bei knappem Speicherplatz
  ([Sicherungen](docs/backups.md), [Release-Kanäle](docs/release-channels.md),
  [Systemstatus](docs/system-status.md)).

## Voraussetzungen

- macOS 14 oder neuer (Apple Silicon oder Intel) oder Linux auf x64 oder arm64.
- Node.js 22.13 oder neuer (in Release-Paketen enthalten), Git und tmux.
- Optional: Tailscale für den Fernzugriff und ein Chromium-basierter Browser für das
  Browser-Tool der Agenten (Brave oder Chromium für sichtbare Browserfenster der
  Agenten; AgentPier kann dafür mit einem Klick ein verwaltetes Chrome for Testing
  installieren).
- Mindestens eine Coding-CLI oder ein Modell-Provider. Provider-Accounts und ihre
  Kosten liegen bei dir.

## Installation

**macOS, Installationsskript.** Installiert die Voraussetzungen und den
Anmeldedienst:

```sh
(agentpier_tmp=$(mktemp -d) && trap 'rm -rf "$agentpier_tmp"' EXIT && curl --fail --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases/latest/download/install-agentpier.sh -o "$agentpier_tmp/install.sh" && /bin/sh "$agentpier_tmp/install.sh")
```

**macOS, Homebrew:**

```sh
brew install ranger-marketing-vertriebs-gmbh/tap/agentpier-installer && agentpier-install
```

Beide öffnen AgentPier unter **http://127.0.0.1:4380**. Optionen:
[Installationsanleitung](docs/installation.md#one-command-installation-on-macos).

**Linux.** Lade das `.aprelease`-Paket für deine Architektur aus den
[Releases](https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases)
herunter und installiere es aus einem Checkout mit
`sh scripts/install.sh --archive <Paket> --service`. Siehe die
[Linux-Anleitung](docs/linux.md) und die
[genauen Befehle](docs/operations.md#installer-and-exact-commands).

**Aus dem Quellcode (macOS oder Linux):**

```sh
git clone https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier.git
cd agent-pier
npm ci
npm run build
npm start
```

## Erste Schritte

1. Öffne **http://127.0.0.1:4380** und lege den Benutzer des Arbeitsbereichs an.
   Spätere Besuche brauchen die [Anmeldung](docs/login.md). Erledige das, bevor du
   den Zugriff freigibst.
2. Öffne **Accounts** über das **Menü** der Seitenleiste: Melde dich unter **Native
   CLI-Accounts** bei einer Coding-CLI an oder lege unter **Modell-Zugänge** einen
   Provider-Zugang an. Fehlende CLIs lassen sich in der Übersicht installieren.
3. Wähle **Neu › Session**, eine CLI, einen Account und einen Projektordner und
   starte. Das native Terminal übernimmt CLI-Anmeldungen und Menüs; der Chat zeigt
   den gespeicherten Verlauf.
4. Optional: Schalte Agenten unter
   **Einstellungen → Arbeitsbereich → Agenten → Agenten aktivieren** ein und lege
   unter **Agenten** einen an ([Agenten-Anleitung](docs/agents.md)).

Deutsch oder Englisch wählst du unter
**Einstellungen → Arbeitsbereich → Allgemein → Sprache**. Wenn der Webserver stoppt,
laufen die CLI-Sessions weiter; beende eine Session in der Oberfläche, um ihren
CLI-Prozess zu beenden.

## Aktualisieren

Installierte Versionen aktualisierst du unter
**Einstellungen → Betrieb → Updates**, über den Kanal **Stable** oder **Preview**
([Release-Kanäle](docs/release-channels.md)). Startet die neue Version nicht, kehrt
AgentPier zur vorherigen zurück. Coding-CLIs aktualisierst du in der Übersicht
([CLI-Updates](docs/cli-updates.md)); ein von AgentPier installiertes CLI unter seiner
Mindestversion startet erst nach dem Update wieder Sessions. Ein Quellcode-Checkout wird mit `git pull`,
`npm ci` und `npm run build` aktualisiert
([Aktualisieren](docs/installation.md#6-updating)).

> **Upgrade von 1.x**
>
> - Mit 2.0 erstellte Sicherungen lassen sich unter 1.x nicht wiederherstellen.
>   Erstelle vor dem Update eine Sicherung, falls du zurückwechseln willst.
> - Melde dich einmal neu bei OAuth-MCP-Servern an, die du aus verwalteten
>   Codex-Accounts nutzt.
> - Lead-Agenten fragen ihre Mitglieder und geben ihnen Aufgaben jetzt ohne
>   Freigabe-Rückfrage.
> - Die Einstellungen liegen jetzt in den Tabs Arbeitsbereich, Zugriff und Betrieb;
>   alte Links funktionieren weiter.
> - Sicherungen kopieren CLI-Profile nach Allowlist, enthalten Verläufe (Sessions,
>   Chats und AgentBus-Nachrichten von AgentPier sowie CLI-Verläufe) nur verschlüsselt
>   mit Passphrase, und wiederhergestellte Hook-Skripte brauchen erneut `chmod +x`.
>
> Details: [Upgrading from 1.x](docs/installation.md#upgrading-from-1x).

## Anleitungen

Die [Dokumentationsübersicht](docs/README.md) listet alle Anleitungen.

| Bereich    | Anleitungen                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nutzen     | [Eingang](docs/inbox.md) · [Provider](docs/providers.md) · [Pipelines](docs/pipelines.md) · [Dateien](docs/file-explorer.md) · [Artifacts](docs/artifacts.md) · [MCP](docs/mcp.md) · [SSH](docs/ssh-access.md) · [Benachrichtigungen](docs/notifications.md) |
| Agenten    | [Agenten](docs/agents.md) · [Workflows](docs/assistant-workflows.md) · [Modell-Zugänge](docs/assistant-model-connections.md) · [Runtime-Updates](docs/assistant-runtime-updates.md)                                                                          |
| Betreiben  | [macOS](docs/installation.md) · [Linux](docs/linux.md) · [Fernzugriff](docs/remote-access.md) · [Sicherungen](docs/backups.md) · [Betrieb](docs/operations.md) · [Systemstatus](docs/system-status.md) · [Sandbox](docs/sandbox.md)                          |
| Entwickeln | [Architektur](docs/architecture.md) · [UI-Leitfaden](docs/ui-guide.md) · [Einstellungsmuster](docs/settings-pattern.md) · [Tests](docs/testing.md) · [Frontend](web/README.md) · [Mitwirken](CONTRIBUTING.md)                                                |

## Daten und Sicherheitsgrenzen

AgentPier ist ein vertrauenswürdiger persönlicher Arbeitsbereich, keine
Isolationsgrenze zwischen Benutzern. Die Daten liegen bei einem Quellcode-Checkout
in `.data/` und bei einer macOS-Installation in
`~/Library/Application Support/AgentPier`. Sie enthalten Zugangsdaten, Profile,
Session-Metadaten und Unterhaltungen mit privaten Dateirechten, sind aber nicht
verschlüsselt gespeichert. Die Anmeldung schützt den Web-Arbeitsbereich;
[Fernzugriff](docs/remote-access.md) erklärt Tailscale Serve und den Netzwerkmodus.

Coding-CLIs und Agenten laufen als dein Betriebssystembenutzer. Die optionale
[nono-Sandbox](docs/sandbox.md) begrenzt nur CLI-Sessions, keine Agenten. Ein Agent
mit Shell-Zugriff arbeitet mit deinen Anmeldungen, Dateien und Schlüsseln; lokale
MCP-Server führen Befehle auf dem Host aus; der eigene Telegram-Bot eines Agenten
antwortet den Personen, die du zulässt; und Fragen und Aufgaben eines Lead-Agenten
laufen ohne Freigabe bei seinen Mitgliedern. Siehe [SECURITY.md](SECURITY.md).

## Entwicklung

```sh
npm ci
npm run check
npx playwright install chromium webkit
npm run test:e2e
AGENTPIER_TEST_BROWSER=webkit npm run test:e2e
```

Für die Frontend-Entwicklung startest du mit `npm start` das Backend und in einem
zweiten Terminal `npm run dev`. Vite leitet `/api` und `/auth` an das Backend weiter.

Fehlerberichte, Verbesserungen der Dokumentation und fokussierte Pull Requests sind
willkommen. Beginne mit [CONTRIBUTING.md](CONTRIBUTING.md), der
[Testanleitung](docs/testing.md) und der [Frontend-Architektur](web/README.md).
Sicherheitslücken meldest du vertraulich über [SECURITY.md](SECURITY.md).

## Lizenz

AgentPier steht unter der [Apache-2.0-Lizenz](LICENSE). Das enthaltene AgentBus
behält seine [MIT-Lizenz](vendor/agentbus/LICENSE). Abhängigkeiten und
Provider-Marken behalten ihre jeweiligen Hinweise und Rechte; siehe
[Hinweise zu Drittanbietern](THIRD_PARTY_NOTICES.md).
