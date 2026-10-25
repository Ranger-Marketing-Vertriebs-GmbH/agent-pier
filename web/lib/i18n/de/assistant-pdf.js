export const assistantPdfCopy = {
  enable: "PDFs lesen",
  description:
    "Liest PDF-Dateien in seinem Arbeitsordner mit seinem eigenen Modell, samt Seitenbildern, wenn dieses Modell Bilder annimmt. Sonst liest sie das PDF-Ersatzmodell aus Accounts; ohne eines wird nur ihr Text gelesen.",
  reference: (name) => `PDF-Ersatzmodell · ${name}`,
  notSet: "Nicht gewählt",
  title: "PDF-Lesen",
  intro:
    "Agenten lesen PDFs mit ihrem eigenen Modell, wenn es Bilder annimmt. Dieses optionale Ersatzmodell liest sie für Agenten, deren Modell das nicht tut; ohne es lesen diese Agenten nur den Text von PDFs, keine gescannten Seiten oder Seiten ohne Text.",
  model: "Ersatzmodell",
  hint: "Nur für Agenten mit eingeschaltetem „PDFs lesen“, deren eigenes Modell keine Bilder annimmt. Der Text ihrer PDFs und, wenn dieses Modell Bilder annimmt, ihre Seitenbilder werden an es gesendet. Änderungen können den Agentendienst neu starten.",
  textOnly:
    "Auch dieses Modell nimmt keine Bilder an: Es liest den Text von PDFs, aber keine gescannten Seiten oder Seiten ohne Text. Wähle ein Modell, das Bilder annimmt, um auch diese zu lesen.",
  ready: "Bereit",
  status: {
    notSet:
      "Kein Ersatzmodell: Agenten, deren Modell keine Bilder annimmt, lesen nur den Text von PDFs.",
    connectionMissing:
      "Den gewählten Zugang gibt es nicht mehr. Wähle ein anderes Modell.",
    connectionUnavailable:
      "Der gewählte Zugang ist gerade nicht nutzbar: Prüfe seinen Schlüssel oder seine Anmeldung.",
  },
  save: "Ersatzmodell speichern",
  remove: "Ersatzmodell entfernen",
  noConnections: "Lege zuerst unter Modell-Zugänge einen Provider-Zugang an.",
};
