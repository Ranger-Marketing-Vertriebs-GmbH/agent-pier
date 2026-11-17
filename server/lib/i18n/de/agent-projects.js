/** Owner-facing copy of agents creating their own projects (assistantProblem keys). */
export const agentProjects = Object.freeze({
  projectNameInvalid:
    "Der Projektname ist ungültig: kein / oder \\, keine Steuerzeichen, kein führender Punkt, höchstens 255 Bytes.",
  projectNameTooLong:
    "Der Projektname ist zu lang: Benenne den Ordner mit wenigen Wörtern (höchstens 48 Zeichen und 6 Wörter), zum Beispiel shop-redesign, nie mit der Anfrage des Owners.",
  projectExists:
    "Im Standard-Arbeitsverzeichnis gibt es schon einen Eintrag mit diesem Namen.",
  projectNotCreatedByYou: "Dieses Projekt hat der Agent nicht selbst angelegt.",
  projectNotEligible:
    "Projekte anlegen können nur eigene Agenten, die kein Teammitglied sind und keinen Telegram-Bot für andere Personen haben.",
  projectFolderUnavailable:
    "Im Standard-Arbeitsverzeichnis kann kein eigenes Projekt angelegt werden: Es fehlt, ist nicht beschreibbar oder liegt in einem anderen Projekt.",
  telegram: {
    created: (agent, name, path) =>
      `${agent} hat das Projekt ${name} in ${path} angelegt.`,
    createdWithCoding: (agent, name, path) =>
      `${agent} hat das Projekt ${name} in ${path} angelegt. Coding-Sessions sind eingeschaltet.`,
    codingOn: (agent, name) =>
      `${agent} hat Coding-Sessions für das Projekt ${name} eingeschaltet.`,
    codingOff: (agent, name) =>
      `${agent} hat Coding-Sessions für das Projekt ${name} ausgeschaltet.`,
  },
});
