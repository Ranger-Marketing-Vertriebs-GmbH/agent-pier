export const assistantPdfCopy = {
  enable: "PDFs lesen",
  description:
    "Liest PDF-Dateien in seinem Arbeitsordner mit dem in Accounts gewählten PDF-Modell. Ihr Text und, wenn dieses Modell Bilder annimmt, ihre Seitenbilder gehen an es.",
  unavailable: {
    notSet:
      "Wähle zuerst unter Accounts › Dienste für Agenten › PDF-Lesen ein PDF-Modell.",
    connectionMissing:
      "Den Provider-Zugang des PDF-Modells gibt es nicht mehr. Wähle unter Accounts › Dienste für Agenten › PDF-Lesen ein anderes.",
    connectionUnavailable:
      "Der Provider-Zugang des PDF-Modells ist gerade nicht nutzbar. Prüfe ihn unter Accounts.",
  },
  reference: (name) => `PDF-Modell · ${name}`,
  notSet: "Nicht gewählt",
  title: "PDF-Lesen",
  model: "PDF-Modell",
  hint: "Jeder Agent mit eingeschaltetem „PDFs lesen“ liest PDFs mit diesem einen Modell. Ihr Text und, wenn das Modell Bilder annimmt, ihre Seitenbilder werden an es gesendet. Änderungen können den Agentendienst neu starten.",
  textOnly:
    "Dieses Modell nimmt keine Bilder an: Es liest den Text von PDFs, aber keine gescannten Seiten oder Seiten ohne Text. Wähle ein Modell, das Bilder annimmt, um auch diese zu lesen.",
  ready: "Bereit",
  status: {
    notSet: "Kein Modell gewählt: Agenten können erst PDFs lesen, wenn du eines wählst.",
    connectionMissing:
      "Den gewählten Zugang gibt es nicht mehr. Wähle ein anderes Modell.",
    connectionUnavailable:
      "Der gewählte Zugang ist gerade nicht nutzbar: Prüfe seinen Schlüssel oder seine Anmeldung.",
  },
  save: "PDF-Modell speichern",
  remove: "PDF-Modell entfernen",
  noConnections: "Lege zuerst unter Modell-Zugänge einen Provider-Zugang an.",
};
