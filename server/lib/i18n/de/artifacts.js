export const artifacts = {
  ARTIFACT_UNSUPPORTED_FILE: (name) =>
    `Dateityp nicht unterstützt: „${name}“. Veröffentliche einen Ausgabeordner mit HTML, CSS, JavaScript, JSON, Bildern und Schriftarten; entferne andere Dateien wie README.md aus dieser Kopie.`,
  ARTIFACT_UNSAFE_FILE: (name) =>
    `„${name}“ ist keine reguläre Datei mit genau einer Verknüpfung. Symbolische Links, Hardlinks und spezielle Dateien sind nicht erlaubt.`,
  ARTIFACT_INVALID_BUNDLE_PATH: (name) =>
    `Ungültiger Dateiname oder Pfad: „${name}“. Verwende einfache ASCII-Namen mit Buchstaben, Zahlen, Leerzeichen, Punkten, Unterstrichen oder Bindestrichen; keine übergeordneten Pfade (..).`,
  ARTIFACT_DUPLICATE_FILE: (name) =>
    `Dateiname mehrfach vorhanden: „${name}“. Namen müssen auch unabhängig von Groß- und Kleinschreibung eindeutig sein.`,
  ARTIFACT_INVALID_ENTRYPOINT: (name) =>
    `Ungültige Startdatei: „${name}“. Bei einem Ordner muss entrypoint eine enthaltene HTML-Datei benennen; bei einer einzelnen Datei muss der Name übereinstimmen.`,
  ARTIFACT_OUTSIDE_WORKSPACE:
    "Der Quellpfad liegt außerhalb des Sitzungsverzeichnisses. Wähle einen Ausgabeordner innerhalb dieses Verzeichnisses.",
  ARTIFACT_STRUCTURE_LIMIT:
    "Der Ausgabeordner enthält zu viele Einträge oder ist zu tief verschachtelt (maximal 1.500 Einträge und 32 Unterordnerebenen).",

  ARTIFACT_RESOURCE_UNSUPPORTED: "Nicht unterstützte oder fehlende Artifact-Ressourcen.",
  ARTIFACT_INVALID_SOURCE:
    "Wähle eine HTML-Datei, ein Bild oder einen Ausgabeordner im Sitzungsverzeichnis. Verknüpfungen und spezielle Dateien können nicht veröffentlicht werden.",
  ARTIFACT_LIMIT_EXCEEDED:
    "Das Speicher- oder Veröffentlichungslimit wurde erreicht. Lösche ungenutzte Artifacts oder verkleinere die Dateien.",
  ARTIFACT_STORAGE_FULL: "Nicht genügend Speicher für dieses Artifact.",
  ARTIFACT_SOURCE_CHANGED:
    "Die Quelldateien wurden während der Veröffentlichung geändert. Veröffentliche erneut mit einer neuen Anfrage-ID.",
  ARTIFACT_ACCESS_DENIED: "Diese Sitzung darf auf dieses Artifact nicht zugreifen.",
  ARTIFACT_PROJECT_CHANGED:
    "Das Projekt dieser Sitzung hat sich geändert. Lade die Sitzung neu, um fortzufahren.",
  ARTIFACT_SESSION_GONE:
    "Die ursprüngliche Sitzung wurde gelöscht oder wird gerade gelöscht.",
  ARTIFACT_NOT_FOUND: "Dieses Artifact ist nicht verfügbar oder wurde gelöscht.",
  ARTIFACT_INVALID_INPUT: "Prüfe die Artifact-Angaben.",
  ARTIFACT_CONFLICT: "Diese Anfrage-ID wurde bereits mit anderen Angaben verwendet.",
  ARTIFACT_UNAVAILABLE:
    "Die Artifact-Veröffentlichung ist vorübergehend nicht verfügbar.",
  ARTIFACT_BUSY: "Ein anderes Artifact wird geladen. Versuche es gleich erneut.",
  ARTIFACT_IO_ERROR: "Das Artifact konnte nicht gelesen oder gespeichert werden.",
};
