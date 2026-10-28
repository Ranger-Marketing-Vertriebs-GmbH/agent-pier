/** Owner-facing copy of agents creating their own projects (assistantProblem keys). */
export const agentProjects = Object.freeze({
  projectNameInvalid:
    "Der Projektname ist ungültig: kein / oder \\, keine Steuerzeichen, kein führender Punkt, höchstens 255 Bytes.",
  projectExists:
    "Im Standard-Arbeitsverzeichnis gibt es schon einen Eintrag mit diesem Namen.",
  projectCreateLimit: (count) =>
    `Dieser Agent hat in den letzten 24 Stunden schon ${count} Projekte angelegt.`,
  projectOwnerOnly:
    "Projekte kann der Agent nur in einem Zug deiner eigenen Nachricht anlegen oder ändern, nicht aus weitergeleiteten, geplanten oder Hook-Inhalten.",
  projectNotCreatedByYou: "Dieses Projekt hat der Agent nicht selbst angelegt.",
  projectNotEligible:
    "Projekte anlegen können nur eigene Agenten, die kein Teammitglied sind und keinen Telegram-Bot für andere Personen haben.",
  projectFolderUnavailable:
    "Im Standard-Arbeitsverzeichnis kann kein eigenes Projekt angelegt werden: Es fehlt, ist nicht beschreibbar oder liegt in einem anderen Projekt.",
});
