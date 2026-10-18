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
  drop: "Dateien hier ablegen",
});
