export const previews = {
  PREVIEW_NOT_LISTENING: (port) =>
    `Auf Port ${port} lauscht kein Server. Starte den Dev-Server und versuche es erneut.`,
  PREVIEW_PORT_FORBIDDEN: (port) =>
    `Port ${port} kann nicht als Vorschau freigegeben werden (AgentPier selbst, der Vorschau-Portbereich oder ein interner Port).`,
  PREVIEW_RANGE_FULL:
    "Alle Vorschau-Ports sind belegt. Schließe eine Vorschau oder vergrößere den Portbereich in den Einstellungen.",
  PREVIEW_DISABLED:
    "Vorschauen sind ausgeschaltet. Schalte sie unter Einstellungen › Fernzugriff › Vorschauen ein.",
  PREVIEW_UNAVAILABLE:
    "Vorschauen sind über Tailscale nicht erreichbar. Schalte Einstellungen › Fernzugriff › Vorschauen erneut ein oder führe `npm run tailscale` aus.",
  PREVIEW_INVALID_INPUT: "Prüfe die Vorschau-Angaben.",
  PREVIEW_NOT_FOUND: "Diese Vorschau existiert nicht mehr.",
  PREVIEW_RANGE_INVALID:
    "Ungültiger Portbereich: erlaubt sind Ports von 1024 bis 65535, höchstens 50 Ports, ohne den Port von AgentPier, den Pipeline-Portbereich und den Tailscale-HTTPS-Port.",
  pages: {
    bounceTitle: "Vorschau wird geöffnet …",
    bounceLink: "Weiter zur Vorschau",
    signInTitle: "Bei AgentPier anmelden",
    signInText:
      "Diese Vorschau wird von AgentPier bereitgestellt. Melde dich als Besitzer bei AgentPier an; danach öffnet sich die Vorschau wieder.",
    signInLink: "Bei AgentPier anmelden",
    forbiddenTitle: "Kein Zugriff",
    forbiddenText: "Nur der Besitzer dieses AgentPier kann Vorschauen öffnen.",
    idleTitle: "Auf diesem Port läuft keine Vorschau",
    idleText:
      "Diese Vorschau wurde geschlossen oder ist abgelaufen. Bitte die Session oder den Agenten um einen neuen Link.",
    unreachableTitle: (port) => `Der Server auf Port ${port} antwortet nicht`,
    unreachableText: (label) =>
      `Die Vorschau „${label}“ bleibt geöffnet. Lade diese Seite neu, sobald der Server wieder läuft.`,
    unauthorized: "Anmeldung bei AgentPier erforderlich.",
  },
};
