# Fernzugriff einrichten

AgentPier lauscht standardmäßig nur auf Loopback (`127.0.0.1`) und ist damit nur auf dem Rechner selbst erreichbar. Für den Zugriff von einem anderen Gerät gibt es zwei gleichwertige Wege. Beide setzen die Anmeldung am Arbeitsbereich voraus (siehe [Anmeldung](login.md)); ohne einen dieser beiden Wege bleibt AgentPier lokal.

|              | Weg A: Tailscale Serve         | Weg B: Netzwerkmodus ohne Tailscale  |
| ------------ | ------------------------------ | ------------------------------------ |
| Transport    | HTTPS im eigenen Tailnet       | Klartext-HTTP im eigenen Netz        |
| Identität    | Tailscale-Konto plus Anmeldung | nur die Anmeldung                    |
| Push/PWA     | ja                             | nein                                 |
| Geeignet für | unterwegs, mehrere Netze       | Heimnetz, LAN, eigener Reverse-Proxy |

Beide Wege lassen sich unabhängig voneinander einrichten und auch gleichzeitig verwenden.

## Weg A: Tailscale Serve

### Voraussetzungen

- Ein bestehendes Tailscale-Konto; auf dem AgentPier-Rechner läuft Tailscale bereits und ist angemeldet.
- Dieselbe `AGENTPIER_DATA_DIR` für den Webdienst und für das Setup-Skript.
- AgentPier bindet dabei weiterhin an Loopback und akzeptiert nur die beim Einrichten ermittelte eigene Tailscale-Identität. Es richtet dabei keinen öffentlichen Funnel ein und exponiert den Dienst nicht ins offene Internet.

### Einrichten

Bei laufendem und angemeldetem Tailscale auf dem Zielrechner:

```sh
npm run tailscale
npm run service:install
```

Der zweite Befehl lädt die neu gespeicherte Remote-Konfiguration. Das Skript bewahrt vorhandene Serve-Freigaben und wählt einen freien Port aus 8443, 10000 oder 9443; es kann eine exakt passende bestehende AgentPier-Freigabe wiederverwenden. Es gibt eine private HTTPS-URL aus, die auch in AgentPier erscheint.

Öffne diese URL auf einem mit demselben Tailnet verbundenen Gerät. Der Rechner muss dafür eingeschaltet, wach und mit Tailscale verbunden bleiben; passende Energieeinstellungen richtet AgentPier nicht automatisch ein. Nach einem Neustart des Rechners sind alte CLI-Prozesse beendet und müssen bewusst neu gestartet werden.

### Separate AgentPier-Identität

Ein Rechner, der bereits eine eigene Tailscale-Identität hat, kann für AgentPier zusätzlich einen separaten Userspace-Daemon mit eigenem Status und Socket betreiben. Das gibt AgentPier einen eigenen MagicDNS-Namen, ohne den vorhandenen Host umzubenennen. Die Optionen `--tun=userspace-networking` sowie eigene State-/Socket-Pfade beschreibt Tailscale in seiner [Daemon-Referenz](https://tailscale.com/docs/reference/tailscaled).

Ein privates Verzeichnis außerhalb des Anwendungs-Release-Baums anlegen und einen installierten `tailscaled`-Binary verwenden:

```sh
mkdir -p "$HOME/.local/share/agentpier-tailscale"
chmod 700 "$HOME/.local/share/agentpier-tailscale"
tailscaled --tun=userspace-networking \
  --statedir="$HOME/.local/share/agentpier-tailscale" \
  --socket="$HOME/.local/share/agentpier-tailscale/tailscaled.sock" \
  --port=0
```

Den Daemon über einen eigenen Benutzerdienst dauerhaft laufen lassen. Kein bestehendes Tailscale-Socket/-Status wiederverwenden oder ersetzen. In einem anderen Terminal die neue Identität anfordern:

```sh
tailscale --socket="$HOME/.local/share/agentpier-tailscale/tailscaled.sock" \
  up --hostname=agentpier --accept-dns=false
```

Die ausgegebene Autorisierungs-URL öffnen und anschließend den privaten HTTPS-Handler mit diesem Daemon konfigurieren:

```sh
export AGENTPIER_TAILSCALE_SOCKET="$HOME/.local/share/agentpier-tailscale/tailscaled.sock"
export AGENTPIER_TAILSCALE_HTTPS_PORT=443
npm run tailscale
npm run service:install
```

Der Einrichtungsbefehl gibt die tatsächliche Tailnet-URL aus; eine Namenskollision kann zu einem abweichenden Namen führen. Port 443 wird nur akzeptiert, wenn er frei oder bereits vom exakt gleichen AgentPier-Loopback-Handler belegt ist. AgentPier speichert die entstehende HTTPS-Origin und die autorisierte Anmeldung im privaten Datenverzeichnis. Die [Serve-Referenz](https://tailscale.com/docs/reference/tailscale-cli/serve) beschreibt den tailnet-internen Proxy und die HTTPS-Voraussetzungen.

### Entfernen

Um nur diese Freigabe zu entfernen, das dazugehörige Socket verwenden und den tatsächlich eingerichteten Port angeben, zum Beispiel:

```sh
tailscale serve --https=8443 off
```

Kein `tailscale serve reset` verwenden, wenn andere Freigaben bestehen. Anmeldedaten privat halten und nicht in eine Sicherung für ein anderes Gerät übernehmen; auf diesem stattdessen eine neue Identität autorisieren.

## Weg B: Netzwerkmodus ohne Tailscale

### Was du akzeptierst

> WARNUNG: Netzwerkzugriff ohne TLS. Passwort und Inhalte gehen unverschlüsselt durchs Netz. Keine Push-Benachrichtigungen und keine PWA-Installation. Nur in vertrauenswürdigen Netzen verwenden und keine Portweiterleitung ins Internet einrichten. Auch über IPv6 oder eine öffentliche Adresse darf der Port nicht aus dem Internet erreichbar sein; im Zweifel die Firewall des Rechners prüfen.

Dieser Warntext erscheint sowohl in der Bestätigung auf der Einstellungsseite als auch beim Einschalten über das Skript. Er lässt sich nicht abschalten, solange der Netzwerkmodus aktiv ist.

### Einschalten über die Einstellungen

1. Unter **Einstellungen → Fernzugriff** öffnet sich die Übersicht mit den drei Karten **Lokal**, **Tailscale** und **Netzwerk**.
2. In der Karte **Netzwerk** den Schalter **Netzwerkzugriff** aktivieren.
3. Der Bestätigungsdialog **„Klartext-HTTP einschalten?“** zeigt den obigen Warntext. Erst **„Trotzdem einschalten“** aktiviert den Entwurf; **„Abbrechen“** verwirft ihn.
4. Optional die **Bind-Adresse** wählen (alle Schnittstellen `0.0.0.0`, alle Schnittstellen inklusive IPv6 `::`, oder eine erkannte Adresse) und unter **Zusätzliche Hosts** Namen oder IPs ohne Port hinzufügen, etwa einen eigenen DNS-Namen oder den Host eines eigenen Reverse-Proxys. Erkannte Adressen sind automatisch erlaubt und müssen nicht eingetragen werden.
5. **„Speichern“** schreibt die Konfiguration. Solange die laufende Bindung noch abweicht, erscheint der Hinweis auf einen nötigen Neustart und der Knopf **„Dienst neu starten“**.
6. Nach dem Neustart zeigt die Karte **Erreichbare Adressen** die tatsächlichen URLs zum Öffnen oder Kopieren.

Ist der Netzwerkmodus bereits aktiv, lässt er sich über diesen Zugang nur wieder ausschalten; Bind-Adresse und Hostliste bleiben dann schreibgeschützt, damit ein Tippfehler den Zugang nicht versehentlich sperrt. Bind-Adresse und Hostliste lassen sich in diesem Fall lokal oder über Tailscale ändern.

### Einschalten per Skript (headless)

```sh
npm run remote -- enable --accept-plain-http
npm run remote -- enable --bind 0.0.0.0 --host agentpier.home.arpa --host macmini.local --accept-plain-http
npm run remote -- hosts --add proxy.example.net
npm run remote -- status
npm run remote -- disable
```

`npm run remote -- enable` ohne `--accept-plain-http` gibt denselben Warntext aus und bricht mit Exit-Code 2 ab, statt interaktiv nachzufragen; das hält die Automatisierung nicht-interaktiv. `--bind` ist standardmäßig `0.0.0.0`; `--host` lässt sich mehrfach wiederholen. `hosts --add <name>` und `hosts --remove <name>` pflegen die Hostliste unabhängig vom Ein-/Ausschalten; ein unbekannter Name bei `--remove` erzeugt die Meldung „`<name>` steht nicht in der Hostliste“, ohne die übrigen Einträge zu verändern. `--no-restart` überspringt den Neustart und zeigt stattdessen den Hinweis, dass die Änderung erst nach dem nächsten Dienststart gilt.

### Hostliste: Beispiele

Die Hostliste in `network.hosts` ergänzt die automatisch erlaubten Namen: die zur Startzeit erkannten Schnittstellenadressen, der Rechnername (`os.hostname()`) und `<Rechnername>.local`, jeweils zusammen mit dem konfigurierten Port. Typische Einträge:

- **IP-Adresse:** die im eigenen Netz zugewiesene Adresse, zum Beispiel `192.168.1.42` — wird meist bereits automatisch erkannt und muss dann nicht eingetragen werden.
- **`.local`-Name:** `macmini.local`, sofern mDNS/Bonjour im Netz funktioniert.
- **Eigener DNS-Name:** ein selbst vergebener Name wie `agentpier.home.arpa`, wenn im Heimnetz ein eigener DNS-Eintrag existiert.
- **Reverse-Proxy-Host:** der öffentlich sichtbare Name des eigenen Proxys, zum Beispiel `proxy.example.net`. Der Proxy zeigt dabei auf `http://127.0.0.1:<Port>`; `x-forwarded-*`- und `forwarded`-Header werden im Netzwerkmodus ignoriert, nicht ausgewertet, und der Proxy-Hostname muss deshalb selbst in der Hostliste stehen.

Jeder Eintrag ist ein Name oder eine IP ohne Schema, Pfad oder Port; es sind höchstens 20 Einträge erlaubt. Änderungen an Bind-Adresse oder Hostliste wirken erst nach einem Neustart des Diensts.

### Neustart und Prüfung

Sowohl das Speichern in den Einstellungen als auch `npm run remote -- enable`/`disable`/`hosts` stoßen anschließend einen Neustart des installierten Diensts an (`--no-restart` überspringt das) und prüfen danach `/api/health` auf Loopback. Ist kein Dienst installiert, meldet das Skript den manuellen Neustart mit `npm start` oder `npm run service:install`.

Ein Gerät, dessen Host-Header nicht erlaubt ist, oder ein Zugriff bei ausgeschaltetem Netzwerkmodus erhält die Fehlermeldung „Netzwerkzugriff ist aus oder dieser Host ist nicht freigegeben. Einstellungen → Fernzugriff prüfen.“ In diesem Fall die Hostliste und den Bind-Modus prüfen und, falls nötig, den Dienst nach einer Änderung neu starten.

### Ausschalten

Über die Einstellungsseite den Schalter **Netzwerkzugriff** wieder deaktivieren und speichern, oder headless:

```sh
npm run remote -- disable
```

Die Hostliste bleibt dabei erhalten und lässt sich beim nächsten Einschalten weiterverwenden.

## Was die Anmeldung schützt und was nicht

- **Schützt:** alle APIs, die Terminal-WebSockets und die statischen Arbeitsbereichsdaten; ein Rate-Limit von zehn Versuchen pro Minute begrenzt das Erraten des Passworts.
- **Schützt nicht:** das Mitlesen im Netz bei Weg B — dort sind Passwort und Inhalte unverschlüsselt sichtbar für alle, die denselben Netzverkehr sehen können. Geräte im selben Netz können außerdem die Anmeldeseite selbst erreichen und darstellen, auch ohne gültige Zugangsdaten.
- **MCP:** Bei aktivem Netzwerkmodus erreichen auch LAN-Clients den MCP-Endpunkt. Die öffentliche OAuth-Resource-URL bleibt dabei die Tailscale-Adresse oder Loopback; ein LAN-Host wird dafür nicht automatisch gewählt. Das ist eine bekannte Einschränkung.
