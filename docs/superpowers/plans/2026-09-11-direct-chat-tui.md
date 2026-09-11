# Direct Chat-to-TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chatnachrichten für Codex, Claude und OpenCode direkt und nachvollziehbar an die laufende TUI übergeben, einschließlich laufender Aufgaben.

**Architecture:** Der vorhandene HTTP-Auftrag und die dauerhaften Zustellungsbelege bleiben bestehen. Ein serverseitiger TUI-Adapter ersetzt den Codex-Queue-Aufruf im Chat, unter der vorhandenen Session-Sperre. Native History-Bindings bleiben für Lesen, Resume und Identitätswechsel erhalten.

**Tech Stack:** JavaScript ES Modules, React, Express, tmux, node:test, Playwright.

**Spec:** [Direkte Chat-Eingabe in die TUI](../specs/2026-09-11-direct-chat-tui-design.md)

## Global Constraints

- Node.js 22.13+, macOS und Linux; keine neue Laufzeitabhängigkeit oder Broker.
- HTTP-API, Zustellungsstatus und bestehende WebSocket-Ausgabekanäle bleiben kompatibel.
- Source-/Testdateien bleiben unter 600 Zeilen. Profile und Belege brauchen keine Migration.
- Tests ausschließlich mit temporären Datenverzeichnissen und privatem tmux-Server.
- Keine Testnachrichten in laufende Nutzersessions, keine Übernahme privater Credentials.
- Höchstens einmal versuchte Übergabe; nach möglichem Schreiben niemals automatisch erneut senden.
- Neue UI-Meldungen in beiden Katalogen, importiert über reaktive Messages.
- Dieser Auftrag umfasst Planung. Die nachfolgenden Checkboxen sind nicht ausgeführt.

## Task 1: Native Übergabe nachweisen und Latenz lokalisieren

**Files:**

- Create: `scripts/probe-chat-tui.mjs`
- Create: `tests/helpers/tui-input-recorder.js`
- Create: `docs/direct-chat-tui-validation.md`
- Read: `tests/integration/chat-slash-commands.test.js`, `tests/helpers/application.js`

**Interfaces:** Der Recorder exportiert `createTuiInputRecorder(fixture)` und liefert
`{ command, args, waitForText(text), readBytes(), receivedAt() }`. Er läuft als
synthetisches Raw-TTY-Programm innerhalb der Fixture und aktiviert Bracketed Paste.
`readBytes()` liefert einen Buffer; `receivedAt()` monotone Empfangszeitpunkte.
Das Probe-Skript hat die Modi `--synthetic` und `--native --tool codex|claude|opencode`.
Native Ausführung verwendet frische Profile, privates tmux und ein temporäres Projekt;
fehlende Testprovider-Konfiguration beendet den Versuch als nicht ausführbar.

- [ ] Recorder aus dem bestehenden Slash-tmux-Test extrahieren und dessen Test
      unverändert damit ausführen. Bytegrenzen müssen über mehrere stdin-Chunks hinweg
      erkannt werden; nicht voraussetzen, dass ein Schreibvorgang ein Event erzeugt.
- [ ] Probe über vorhandene Application-Fixture aufbauen. Vergleich im selben
      Testlauf: bestehender Chatweg, direkte Paste mit anschließendem Enter und vorhandene
      Slash-Übergabe. Nur synthetische Marker und Laufzeiten ausgeben.
- [ ] Für jede echte CLI Version, Plattform, Idle-/Busy-Verhalten, vorhandenen
      Entwurf, Dialoge, native Submit-Taste und nötigen Paste-Abstand dokumentieren.
      Der Busy-Test hält eine kontrollierte Aufgabe mindestens fünf Sekunden offen
      und prüft die Annahme der zweiten Nachricht vor ihrem Ende.
- [ ] Mindestens 30 Übergaben je CLI lokal messen. HTTP-Eingang bis Submit und
      sichtbares Echo separat ausweisen; kein Schluss aus HTTP-Erfolg auf native Annahme.
- [ ] Entscheidung festhalten: Nur bei zuverlässiger Busy-Annahme und sicher
      erkennbaren Eingabekonflikten folgt die Umstellung dieser CLI. Bei fehlendem
      Nachweis bleibt ihre Umstellung offen; kein heuristisches Nachsenden von Enter.

```sh
node --test tests/integration/chat-slash-commands.test.js
node scripts/probe-chat-tui.mjs --synthetic
node scripts/probe-chat-tui.mjs --native --tool codex
node scripts/probe-chat-tui.mjs --native --tool claude
node scripts/probe-chat-tui.mjs --native --tool opencode
```

Commit: `test: characterize direct TUI chat input and latency`

## Task 2: Text- und Eingabeadapter mit Regressionstests

**Files:**

- Create: `server/features/sessions/session-chat-input.js`
- Create: `tests/unit/session-chat-input.test.js`
- Create: `tests/fixtures/tui-input/` (bereinigte synthetische Composer-/Dialogzustände)
- Read: `server/features/sessions/session-slash-command.js`

**Interfaces:**

- `normalizeChatText(text): string` normalisiert Zeilenumbrüche, prüft 32.000 Zeichen
  und lehnt Terminal-Steuerzeichen außer Tab/LF ab.
- `assertChatComposerReady(tool, raw): void` akzeptiert die in Task 1 belegten
  empfangsbereiten Idle-/Busy-Zustände; belegte oder nicht sicher erkennbare Composer
  werden vor dem Schreiben abgelehnt. Keine pauschale Abhängigkeit vom Busy-Indikator.
- `writeChatTuiInput(manager, session, text): Promise<void>` verwendet den bestehenden
  Slash-Helper, sonst eindeutigen tmux-Puffer, Paste und separat den in Task 1
  nachgewiesenen Submit. Aufrufer hält die Session-Sperre und hat den Beleg gesichert.

- [ ] Zuerst fehlschlagende Validierungs- und Composer-Tests schreiben, unter anderem:

```js
assert.equal(normalizeChatText("A\r\nB\rC\tD"), "A\nB\nC\tD");
assert.throws(() => normalizeChatText("text\x1b[201~\r"));
assert.throws(() => normalizeChatText("text\x03"));
assert.throws(() => normalizeChatText("text\x9b"));
```

- [ ] Für jede CLI akzeptierte leere Idle-/Busy-Composer sowie Ablehnung von
      vorhandenen Entwürfen, Dialogen und unbekannten Screens mit Fixtures prüfen.
      Erkennung auf den Eingabebereich begrenzen, nicht auf Wörter im Antworttext.
- [ ] Adapter implementieren. Nachrichteninhalt ausschließlich als Pufferdaten,
      niemals als Shellcode oder Tastennamen behandeln. Puffer nach Erfolg oder Fehler
      aufräumen; bei partiellem Schreiben kein zweiter Versuch.
- [ ] Tests für Unicode, Tab, Mehrzeiler, Dateipfade mit Leerzeichen, Slash-Befehle,
      mehrzeilige Slash-Erwähnungen, Pastefehler und Enterfehler ergänzen.
- [ ] Rot-Grün prüfen, danach committen.

```sh
node --test tests/unit/session-chat-input.test.js
```

Commit: `feat: add guarded direct TUI chat input adapters`

## Task 3: Chat auf den geprüften TUI-Weg umstellen

**Files:**

- Modify: `server/features/chat/chat-delivery.js`
- Modify: `server/features/sessions/session-manager.js`
- Modify: `server/application/services.js`
- Modify: `tests/integration/chat-delivery.test.js`
- Modify: `tests/integration/session-input-concurrency.test.js`
- Modify: `tests/integration/chat-slash-commands.test.js`
- Modify: `tests/integration/sessions.test.js`
- Modify if unused: `server/features/chat/provider-history.js`

**Interfaces:** `SessionManager.inputChat(id, text, beforeInput): Promise<void>`
ist der neue Chat-Einstieg. Er serialisiert auf `id`, prüft laufende interaktive
Session und Reload, liest den aktuellen Screen und ruft erst nach erfolgreicher
Composer-Prüfung `beforeInput(session, raw)` auf. Danach schreibt er mit Task 2.
Bestehendes `input(id, text, submit, beforeInput)` bleibt für sonstige Eingaben;
der bisherige fünfte `nativeQueue`-Callback entfällt nach Aktualisierung aller Aufrufer.

- [ ] HTTP-Tests zuerst so ändern, dass normale Chatnachrichten aller drei CLIs
      genau einen TUI-Schreibversuch auslösen. `history.queue` und Input-Thread-Auflösung
      dürfen dabei nicht aufgerufen werden. Den bisherigen Codex-Queue-Test ersetzen.
- [ ] Neue Methode als dünnen Einstieg implementieren; größere Logik gehört in
      `session-chat-input.js`, da der Manager bereits nahe an 600 Zeilen liegt.
- [ ] In `ChatDelivery.send` bestehende Belege nach den bisherigen Scope-/Hash-Regeln
      beantworten. Den Hash weiterhin aus Originaltext und Submit bilden. Nur für
      neue Aufträge Text vor Reservierung normalisieren und zusätzlich prüfen;
      der normalisierte Text wird geschrieben. So bleiben Upgrade-Replays auch
      mit CRLF oder inzwischen abgelehnten Steuerzeichen lesbar und schreiben
      nichts erneut. Diese Fälle als Regressionstests ergänzen; keine Belegmigration.
- [ ] Bestehenden Callback mit Scope-, Request- und Modellprüfungen sowie dauerhaftem
      `uncertain` vor dem ersten Schreibvorgang weiterverwenden. Der Input-Adapter darf
      bis einschließlich dieses Callbacks keine Zeichen an die TUI schreiben.
- [ ] Abhängigkeiten `bindings/history` nur aus ChatDelivery entfernen. Native
      History-Zuordnung, `/clear`, Resume und Accountwechsel behalten diese Services.
      `ProviderHistory.queue` nur entfernen, wenn die Referenzsuche keine Nutzer ergibt.
- [ ] Concurrency-Test an den tatsächlichen TUI-Submit koppeln, statt an den bisherigen
      Queue-Callback. Replay-, Neustart-, Diskfehler-, Reload- und Dialogtests grün halten.

```sh
rg -n 'nativeQueue|history\.queue|new ChatDelivery' server tests
node --test tests/integration/chat-delivery.test.js tests/integration/session-input-concurrency.test.js tests/integration/chat-slash-commands.test.js tests/integration/sessions.test.js
```

Commit: `fix: deliver chat messages directly to the session TUI`

## Task 4: Tatsächlichen Byte-Transport und Unterbrechungen absichern

**Files:**

- Create: `tests/integration/chat-tui-input.test.js`
- Reuse: `tests/helpers/tui-input-recorder.js`
- Update: `docs/direct-chat-tui-validation.md`

**Interfaces:** HTTP-Aufträge behalten `deliveryId`, `deliveryScope`, `text`,
`submit: true`. Assertions prüfen Recorder-Inhalt und Anzahl der Submit-Sequenzen,
nicht nur HTTP-Status. Native CLI-Abnahme bleibt ein getrennter Nachweis.

- [ ] Mit Application-Fixture und Recorder echte tmux-Sessions aller drei Tools
      starten. Nachrichten über HTTP senden, ohne einen Terminal-WebSocket zu öffnen.
- [ ] Einzeiler, Unicode, lange Mehrzeiler und Dateipfade prüfen: genau ein Payload
      zwischen Pastegrenzen und genau ein nachfolgender Submit; Slash-Befehle separat.
- [ ] Dieselbe Delivery-ID gleichzeitig und nach Neustart wiederholen. Erwartung:
      unveränderter Byte-Recorder und derselbe Beleg, kein zweites Enter.
- [ ] Fehler nach Paste, vor Enter und nach Enter vor Abschlussbeleg injizieren.
      HTTP-Abbruch darf laufende Übergabe nicht wiederholbar machen. Bei unklarer
      Zustellung dürfen nach erneutem Aufruf keine zusätzlichen Bytes eintreffen.
- [ ] Gleichzeitige andere Session, Reload und AgentPier-Terminal-Eingabe prüfen.
      Der Chat-Payload darf nicht durch AgentPier-Schreibvorgänge unterbrochen werden.
- [ ] Native Matrix aus Task 1 mit dem endgültigen HTTP-Weg erneut ausführen und
      Messergebnisse sowie unterstützte CLI-Versionen im Abnahmedokument ergänzen.

```sh
node --test tests/integration/chat-tui-input.test.js tests/integration/session-input-concurrency.test.js
```

Commit: `test: verify direct chat input through owned tmux sessions`

## Task 5: Browser, Dokumentation und Integrationsabschluss

**Files:**

- Modify: `tests/browser/chat-delivery.spec.js`, `tests/browser/chat-sync.spec.js`
- Modify: `docs/mobile-delivery.md`
- Modify when adding conflict copy: corresponding existing message modules under
  `web/lib/i18n/de/`, `web/lib/i18n/en/`, `server/lib/i18n/de/`

**Interfaces:** Bestehende Zustellungsstatus und Chat-Streams bleiben unverändert.
Bei Composer-Konflikt bleibt die Nachricht wieder bearbeitbar; keine stille
Entwurfsvernichtung. `handed-off` wird nicht in „von der KI angenommen“ umbenannt.

- [ ] Chromium/WebKit: Senden ohne offenen Terminal-Tab, mehrere Nachrichten
      nacheinander, zwei Tabs mit derselben Delivery-ID, Verbindungsabbruch und
      Wiederherstellung prüfen. Bei bestätigtem nativen `/clear` folgt die Chatansicht.
- [ ] Konfliktmeldungen auf vorhandene Entwürfe/Dialogsituation beziehen und
      deutsch/englisch ergänzen. Browser-Tests prüfen erhaltenen Text und Bearbeitbarkeit.
- [ ] Dokumentieren: direkte Übergabe, native Busy-Semantik je CLI, Messwerte,
      Grenzen bei externem parallelem Tippen und weiterhin unklare Teilübergaben.
- [ ] Gesamtprüfung und Browser-Suiten ausführen; native Matrix muss je CLI einen
      tatsächlichen Nachweis enthalten. Ein synthetischer Test ersetzt ihn nicht.

```sh
npm run check
AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/chat-delivery.spec.js tests/browser/chat-sync.spec.js
AGENTPIER_TEST_BROWSER=webkit npx playwright test tests/browser/chat-delivery.spec.js tests/browser/chat-sync.spec.js
```

- [ ] Eigenen Folge-PR erstellen, direkte Übergabe und Validierung beschreiben.
      PR #52 vorher integrieren oder explizit als Abhängigkeit ausweisen. Keine
      Release-Version ändern. Review-Funde beheben; Merge erst bei bestandener CI
      und vorhandener Merge-Freigabe.

Commit: `docs: describe direct TUI delivery behavior and validation`
