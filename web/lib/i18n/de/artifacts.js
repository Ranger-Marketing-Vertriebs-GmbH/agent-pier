export const artifactCopy = {
  title: "Artifacts",
  viewer: "Artifact",
  loading: "Artifact wird geladen…",
  unavailable: "Dieses Artifact ist nicht verfügbar.",
  unsupported:
    "Dieses Artifact verwendet nicht unterstützte oder fehlende Ressourcen. Verwende gebündeltes HTML, CSS, JavaScript und Bilder ohne externe Anfragen.",
  description: "Private Ergebnisse aus deinen Coding-Sitzungen.",
  listLoading: "Artifacts werden geladen…",
  empty: "Noch keine Artifacts.",
  retention:
    "Artifacts gehören zur Sitzung. Pinne Ergebnisse an, um sie nach dem Löschen der Sitzung zu behalten.",
  refresh: "Aktualisieren",
  project: "Projekt",
  allProjects: "Alle Projekte",
  pinned: "Angepinnt",
  orphaned: "Ursprüngliche Sitzung gelöscht",
  open: "Öffnen",
  pin: "Anpinnen",
  unpin: "Lösen",
  remove: "Löschen",
  deleteTitle: "Artifact löschen?",
  openLabel: (title) => `${title} öffnen`,
  storage: (used, limit) => `${used} von ${limit} belegt`,
  cleanup: (size) => `${size} warten auf Bereinigung`,
  deleteBody: (title) =>
    `„${title}“ wird mit allen gespeicherten Dateien dauerhaft gelöscht.`,
  deleteOrphan: (title) =>
    `Die ursprüngliche Sitzung existiert nicht mehr. Das Lösen des Pins löscht „${title}“ und seine Dateien dauerhaft.`,
  errors: {
    ARTIFACT_RESOURCE_UNSUPPORTED:
      "Nicht unterstützte oder fehlende Artifact-Ressourcen.",
    ARTIFACT_INVALID_SOURCE:
      "Wähle eine HTML-Datei, ein Bild oder einen Ausgabeordner im Sitzungsverzeichnis. Verknüpfungen und spezielle Dateien können nicht veröffentlicht werden.",
    ARTIFACT_LIMIT_EXCEEDED:
      "Das Speicher- oder Veröffentlichungslimit wurde erreicht. Lösche ungenutzte Artifacts oder verkleinere die Dateien.",
    ARTIFACT_STORAGE_FULL: "Nicht genügend Speicher für dieses Artifact.",
    ARTIFACT_SOURCE_CHANGED:
      "Die Quelldateien wurden während der Veröffentlichung geändert. Veröffentliche erneut mit einer neuen Anfrage-ID.",
    ARTIFACT_ACCESS_DENIED: "Diese Sitzung darf auf dieses Artifact nicht zugreifen.",
    ARTIFACT_SESSION_GONE:
      "Die ursprüngliche Sitzung wurde gelöscht oder wird gerade gelöscht.",
    ARTIFACT_NOT_FOUND: "Dieses Artifact ist nicht verfügbar oder wurde gelöscht.",
    ARTIFACT_INVALID_INPUT: "Prüfe die Artifact-Angaben.",
    ARTIFACT_CONFLICT: "Diese Anfrage-ID wurde bereits mit anderen Angaben verwendet.",
    ARTIFACT_UNAVAILABLE:
      "Die Artifact-Veröffentlichung ist vorübergehend nicht verfügbar.",
    ARTIFACT_BUSY: "Ein anderes Artifact wird geladen. Versuche es gleich erneut.",
    ARTIFACT_IO_ERROR: "Das Artifact konnte nicht gelesen oder gespeichert werden.",
  },
};
