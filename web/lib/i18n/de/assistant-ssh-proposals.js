// An agent's proposal of a new SSH access, waiting for the owner (agent-ssh-proposals.js).
export const sshProposalCopy = {
  title: "SSH-Zugangsvorschlag",
  login: "Anmeldung",
  project: "Projekt",
  noProject: "Kein Projekt",
  purpose: "Zweck",
  fingerprint: "Fingerabdruck des Hostschlüssels (gescannt, nicht geprüft)",
  verify:
    "Prüfe diesen Fingerabdruck über einen Weg, dem du vertraust, etwa die Konsole des Servers, deinen Anbieter oder einen Administrator. Mit der Bestätigung wird er als von dir geprüft gepinnt.",
  key: "Schlüssel",
  newKey: "Neuer verwalteter Schlüssel",
  keysFailed:
    "Die Schlüssel des Projekts konnten nicht geladen werden. Die Bestätigung legt einen neuen verwalteten Schlüssel an.",
  mode: "Modus",
  approve: "Zugang bestätigen",
  created: (name) => `SSH-Zugang „${name}“ angelegt.`,
  installKey:
    "Hinterlege diesen öffentlichen Schlüssel für den entfernten Benutzer (in ~/.ssh/authorized_keys), bevor der Agent sich verbindet. AgentPier hinterlegt ihn nie selbst.",
  history: (name) => `SSH-Zugangsvorschlag: ${name}`,
  diagnostics: {
    HOST_KEY_CHANGED:
      "Der Host hat einen anderen Schlüssel gezeigt als im Vorschlag. Der Agent muss den Zugang neu vorschlagen.",
    HOST_EXISTS: "Dieser Host, Port und Benutzer sind schon ein SSH-Zugang.",
    AGENT_UNAVAILABLE: "Der Agent kann keine SSH-Zugänge mehr haben.",
  },
};
