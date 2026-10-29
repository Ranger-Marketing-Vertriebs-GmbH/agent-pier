export const assistantShoppingCopy = {
  title: "Einkaufen",
  hint: "AgentPier hält keinen Kauf auf: Nur die Anweisungen des Agenten schützen davor. Prüfe den Bestellverlauf deines Shops.",
  description:
    "Sucht Angebote und Bauteile bei Amazon und AliExpress und kauft erst nach deinem Ja in deinem eigenen Chat.",
  needs: (label) => `Braucht „${label}“.`,
  userAgent: "Agenten von Benutzern kaufen nie ein.",
  archived: "Archivierte Agenten kaufen nicht ein.",
  lead: "Aus, solange Einkaufen beim leitenden Agenten aus ist.",
  followsLead: "Folgt dem Schalter „Einkaufen“ des leitenden Agenten.",
};
