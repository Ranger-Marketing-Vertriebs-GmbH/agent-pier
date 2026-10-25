/** Existing German product copy, addressed through English semantic keys. */
export const secrets = Object.freeze({
  invalidName:
    "Ungültiger Geheimnisname. Erlaubt sind Großbuchstaben, Ziffern und Unterstriche, beginnend mit einem Buchstaben oder Unterstrich, höchstens 64 Zeichen.",
  invalidDescription: "Die Beschreibung darf höchstens 200 Zeichen lang sein.",
  invalidValue: "Ungültiger Wert. Erlaubt sind 1 bis 8192 Byte ohne Nullzeichen.",
  invalidProject: "Ungültiges Projekt für das Geheimnis.",
  invalidBody:
    "Ungültige Anfrage. Erlaubt sind nur Name, Beschreibung, Projekt und Wert.",
  nameTaken: "Ein Geheimnis mit diesem Namen existiert bereits.",
  limit: "Es sind höchstens 200 Geheimnisse möglich.",
  invalidSessionSelection:
    "Ungültige Geheimnisauswahl. Eine Session kann höchstens 50 verschiedene Geheimnisse erhalten.",
  loginSessionsUnsupported: "Geheimnisse sind für Login-Sessions nicht verfügbar.",
  notFound: "Geheimnis nicht gefunden.",
});
