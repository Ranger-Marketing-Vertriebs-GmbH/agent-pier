export const assistantAttachmentsCopy = Object.freeze({
  attach: "Datei, Bild oder Video anhängen",
  choose: "Dateien, Bilder oder Videos auswählen",
  list: "Anhänge",
  sent: "Angehängte Dateien",
  shared: "Geteilte Dateien",
  sharedUnavailable: "Diese geteilte Datei ist nicht mehr verfügbar.",
  deleteLabel: "Löschen",
  deleteShared: (name) => `${name} löschen`,
  deleteConfirm: (name) =>
    `„${name}“ aus AgentPier löschen? Die Datei im Arbeitsbereich des Agenten bleibt.`,
  deleteYes: "Löschen",
  deleteNo: "Behalten",
  remove: (name) => `${name} entfernen`,
  open: (name) => `${name} öffnen`,
  download: (name) => `${name} herunterladen`,
  uploading: "Wird hochgeladen …",
  uploadingProgress: (percent) => `Wird hochgeladen … ${percent} %`,
  video: (name) => `Video ${name}`,
  videoTooLarge: (name) => `„${name}“ ist größer als 200 MB.`,
  failed: "Upload fehlgeschlagen",
  tooLarge: (name) => `„${name}“ ist größer als 10 MB.`,
  unsupported: (name) =>
    `„${name}“ wird nicht unterstützt. Erlaubt sind Bilder (JPEG, PNG, WebP, GIF, HEIC), Videos (MP4, MOV, WebM), PDF und Textdateien.`,
  tooMany: (max) => `Eine Nachricht kann höchstens ${max} Dateien enthalten.`,
  noImageInput:
    "Das Modell dieses Agenten kann keine Bilder sehen. Bilder werden nur in seinem Arbeitsbereich gespeichert, damit er sie mit Werkzeugen lesen kann.",
  heicKept:
    "HEIC-Fotos, die dieser Browser nicht umwandeln kann, bekommt der Agent nur als Datei in seinem Arbeitsbereich.",
  unavailable: "Nicht mehr verfügbar",
  storageGroup: "Chat-Anhänge",
  storageHint:
    "Dateien, die du diesem Agenten schickst, liegen in attachments/ seines Arbeitsbereichs, damit er sie mit seinen Werkzeugen lesen kann.",
  storageUsage: (bytes, maxBytes, files, maxFiles) =>
    `${bytes} von ${maxBytes} · ${files} von ${maxFiles} Dateien`,
  storageLoading: "Ordner wird gelesen …",
  storageClear: "Anhänge leeren",
  storageClearDescription:
    "Löscht alle Dateien in attachments/, auch Dateien, die der Agent dort abgelegt hat, und Videos, die noch hochladen. Gesendete Nachrichten behalten die Dateinamen, als nicht mehr verfügbar markiert. Dateien, die der Agent mit dir geteilt hat, bleiben.",
  storageClearTitle: "Anhänge dieses Agenten leeren?",
  storageClearConfirm: "Leeren",
  storageClearCancel: "Abbrechen",
  storageCleared: "Anhänge geleert.",
  drop: "Dateien hier ablegen",
});
