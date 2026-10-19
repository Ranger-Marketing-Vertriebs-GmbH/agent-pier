export const assistantPdfCopy = {
  enable: "PDFs lesen",
  description:
    "Liest PDF-Dateien in seinem Arbeitsordner mit dem in Accounts gewählten PDF-Modell. Ihr Text und ihre Seitenbilder gehen an dieses Modell.",
  unavailable: {
    notSet:
      "Wähle zuerst unter Accounts › Dienste für Agenten › PDF-Lesen ein PDF-Modell.",
    connectionMissing:
      "Den Provider-Zugang des PDF-Modells gibt es nicht mehr. Wähle unter Accounts › Dienste für Agenten › PDF-Lesen ein anderes.",
    connectionUnavailable:
      "Der Provider-Zugang des PDF-Modells ist gerade nicht nutzbar. Prüfe ihn unter Accounts.",
    noImages:
      "Das PDF-Modell kann keine Bilder lesen. Wähle unter Accounts › Dienste für Agenten › PDF-Lesen ein anderes.",
  },
  reference: (name) => `PDF-Modell · ${name}`,
  notSet: "Nicht gewählt",
  title: "PDF-Lesen",
  model: "PDF-Modell",
  hint: "Jeder Agent mit eingeschaltetem „PDFs lesen“ liest PDFs mit diesem einen Modell. Ihr Text und ihre Seitenbilder werden an es gesendet, wähle also ein Modell, das Bilder annimmt. Änderungen können den Agentendienst neu starten.",
  ready: "Bereit",
  status: {
    notSet: "Kein Modell gewählt: Agenten können erst PDFs lesen, wenn du eines wählst.",
    connectionMissing:
      "Den gewählten Zugang gibt es nicht mehr. Wähle ein anderes Modell.",
    connectionUnavailable:
      "Der gewählte Zugang ist gerade nicht nutzbar: Prüfe seinen Schlüssel oder seine Anmeldung.",
    noImages: "Das gewählte Modell kann keine Bilder lesen. Wähle ein anderes Modell.",
  },
  save: "PDF-Modell speichern",
  remove: "PDF-Modell entfernen",
  noConnections: "Lege zuerst unter Modell-Zugänge einen Provider-Zugang an.",
};
