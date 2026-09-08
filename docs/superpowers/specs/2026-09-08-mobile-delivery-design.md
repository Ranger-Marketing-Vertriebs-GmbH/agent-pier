# Mobile Zustellung und Wiederherstellung

Der Nutzer hat den im Wettbewerbsbericht vorgeschlagenen Umfang freigegeben.
Diese Änderung erweitert den vorhandenen Chat, ohne native Eingaben blind zu wiederholen.

## Vertrag

- Browser speichert Text und bestätigte Anhangsmetadaten pro Origin, Session,
  Account, CLI und Session-Erstellungszeit. Bilddaten werden nicht in localStorage
  gespeichert. Noch laufende Dateiübertragungen sind nicht fortsetzbar.
- Vor dem POST wird ein unveränderlicher Auftrag mit UUID, Text und Bindung
  gespeichert. Solange dieser offen ist, bleibt der Composer gesperrt.
- Web Locks serialisiert alle gespeicherten Änderungen zwischen Tabs. Schreiben
  liest unter dem Lock den aktuellen Stand erneut; verspätete Quittungen dürfen
  ausschließlich ihre eigene ID verändern. Ohne Lock-Unterstützung kein Versand.
- Ausgehende Nachrichten erscheinen sofort im Chat mit sichtbarem Übergabestatus.
  Nach erfolgreicher Übergabe bleibt die vorläufige Blase bis zu einem passenden
  neuen User-Eintrag sichtbar. Textabgleich dient nur der Darstellung, niemals als
  Versandquittung; gleiche Nachrichten verbrauchen unterschiedliche Verlaufseinträge.
  Nicht exakt zuordenbare Anzeigen können bewusst geschlossen werden. Höchstens
  20 bereits übergebene vorläufige Anzeigen werden lokal behalten.
- Der Server speichert vor Terminal-Eingabe einen privaten Beleg mit Payload-Hash.
  Dieselbe ID mit derselben Nutzlast liefert den bekannten Stand; abweichende
  Nutzlast oder Session-Bindung wird abgelehnt. Keine automatische Beleg-Expiration;
  Löschen der Session entfernt Belege.
- Zustände: pending (nur aktive Serveroperation), handed-off (tmux-Aufrufe beendet),
  rejected (sicher vor Eingabe abgelehnt), uncertain (Eingabe könnte erfolgt sein),
  absent (kein Beleg). handed-off behauptet keine Provider-Annahme.
- Nach Reload, Online-/Pageshow-/Visibility-Wechsel wird nur der Beleg abgefragt.
  Fehlender Beleg erlaubt einen bewussten erneuten Versuch mit derselben ID.
  Unklare Übergabe erlaubt nach sichtbarem Duplikathinweis eine bewusste Rücknahme
  als Entwurf. Kein automatischer POST beim Aufwachen.
- Browser-Speicherfehler bleiben sichtbar; ohne gespeicherten Auftrag kein POST.
  Unlesbare gespeicherte Daten dürfen nicht still überschrieben werden.
- Native Request-, Modell-, Pipeline- und Session-Guards bleiben aktiv. Prüfung
  und Markierung vor Eingabe laufen innerhalb der bestehenden Session-Serialisierung.

## Grenzen und Abnahme

Kein allgemeines Offline-Queueing, kein Cursor-Transport, kein automatischer
History-Abgleich per Text (identische Texte sind keine eindeutigen Quittungen).
Keine Garantie bei gelöschten Browserdaten. Eine einzelne AgentPier-Instanz besitzt
wie bisher das Datenverzeichnis. Tests verwenden ausschließlich isolierte Fixtures.

Abnahme: verlorene Antwort nach Eingabe, gleichzeitige Wiederholung, Neustart
zwischen Beleg und Quittung, Guard-Ablehnung, geänderte Nutzlast, Account-Wechsel,
Reload von Entwurf und Upload-Manifest, Speicherfehler sowie bestehende Chat-
und Freigabefunktionen. Chromium und WebKit; echter iPhone-Schlaf bleibt manueller Test.
