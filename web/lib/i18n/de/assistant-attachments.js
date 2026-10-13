export const assistantAttachmentsCopy = Object.freeze({
  attach: "Datei oder Bild anhängen",
  choose: "Dateien oder Bilder auswählen",
  list: "Anhänge",
  sent: "Angehängte Dateien",
  remove: (name) => `${name} entfernen`,
  open: (name) => `${name} öffnen`,
  download: (name) => `${name} herunterladen`,
  uploading: "Wird hochgeladen …",
  failed: "Upload fehlgeschlagen",
  tooLarge: (name) => `„${name}“ ist größer als 10 MB.`,
  unsupported: (name) =>
    `„${name}“ wird nicht unterstützt. Erlaubt sind Bilder (JPEG, PNG, WebP, GIF, HEIC), PDF und Textdateien.`,
  tooMany: (max) => `Eine Nachricht kann höchstens ${max} Dateien enthalten.`,
  noImageInput:
    "Das Modell dieses Agenten kann keine Bilder sehen. Bilder werden nur in seinem Arbeitsbereich gespeichert, damit er sie mit Werkzeugen lesen kann.",
  heicKept:
    "HEIC-Fotos, die dieser Browser nicht umwandeln kann, bekommt der Agent nur als Datei in seinem Arbeitsbereich.",
  drop: "Dateien hier ablegen",
});
